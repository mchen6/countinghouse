# CDIF 代码审计与改造施工图
> 审计对象：github.com/mchen6/cdif @ v3.1.2（commit fa527da）
> 目标定位：MCP 工具的多租户运行时 + 货币化/市场后端（项目定名：**countinghouse**，见 P0-5）
> 用途：作为 Claude Code 改造工程的任务清单。每个任务标注了优先级与验收标准。

---

## 一、审计结论摘要

**核心资产确认**：新定位所需的三大差异化能力全部位于开源 repo 内，无 CEAMS 代码混入：

| 能力 | 位置 | 状态 |
|---|---|---|
| worker_threads 多租户隔离 | `lib/sandbox.js`, `lib/worker-message.js`, `lib/module-manager.js` | 完整，真实的独立 V8 堆隔离 + 消息通道 |
| 计量/限流 | `lib/cdif-interface.js`, `lib/device-manager.js`, `lib/session.js`, `lib/redis-api.js` | 完整，Redis per-key |
| verify/publish 市场流水线 | `lib/routes/verify-module.js`, `lib/routes/load-module.js` 等 | 完整 |
| 任务引擎（对位 MCP Tasks 扩展） | `lib/job-control.js`, `lib/routes/add-job.js` 等, 依赖 bull | 完整 |
| 热重载 | `lib/routes/reload-module.js`, chokidar watcher | 完整 |

**Route → MCP 映射表**（网关层设计依据）：

| CDIF route | MCP 概念 |
|---|---|
| GET device-list + get-spec | tools/list（每个 action 展开为一个 tool） |
| POST invoke-action | tools/call |
| GET /devices/:id/schema | tool inputSchema/outputSchema（已解引用） |
| event-sub / event-unsub (WebSocket) | notifications |
| add-job / get-job / get-job-history | Tasks 扩展（2026-07-28 规范） |
| verify-module / load-module / unload-module | 平台管理面（非 MCP，保留为运营 API） |
| connect / disconnect / user-auth / oauth | authorization（对齐 MCP OAuth 2.1 方案） |

---

## 二、阻断性问题（P0，第一批 commit 处理）

### P0-1 许可证冲突
- **现状**：`LICENSE` = Apache 2.0；`package.json` `"license": "APEMESH standard license"`。
- **风险**：权属主张可争辩；尽调红旗；npm 显示非标准 license 字段。
- **行动**：确认历史意图后统一为 `"license": "Apache-2.0"`。若曾以 APEMESH license 对外分发过，在 NOTICE 或 CHANGELOG 里一句话说明自某版本起统一为 Apache 2.0。
- **验收**：`npx license-checker` 干净；package.json 与 LICENSE 一致。

### P0-2 私有依赖 @apemesh/cdif-device-db
- **现状**：从私有 registry `public-reg.apemesh.com:8080` 拉取；被 `framework.js:3`、`lib/device-auth.js:3`、`lib/module-manager.js:282` require。公网无法安装。
- **行动**：三选一——(a) 若该包为你个人代码：并入主 repo 或以新名发公网 npm；(b) 若为公司主体代码：按"参考思路重写"原则重新实现（看用途大概率是 CouchDB/nano 的设备描述存取层，重写成本低）；(c) 抽象成 storage interface，默认给一个无外部依赖的 SQLite/文件实现，CouchDB 作为可选驱动。**推荐 (c)**：顺便消除 CouchDB 这个安装门槛。
- **同时移除**：`publishConfig.registry` 私有源配置。
- **验收**：干净环境 `npm install && npm test` 全绿，零私有源访问。

### P0-3 品牌与元数据清理（改名任务）
- `package.json`：name（@apemesh/cdif → 新名）、author（out4b → 你的名字）、repository URL（现在还指向 out4b/cdif 旧仓库）、keywords（去掉 smart home/Z-Wave 等 IoT 词，换成 mcp/agent/tools/metering/marketplace）。
- 全局 grep：`apemesh`、`cdif`、`CDIF`、`out4b`、`cjcg`（docker 目录下有个疑似客户项目名的子目录，删除或匿名化）、`lingyi-fire-control-data-module`（pre-installed-packages 下的客户模块，删除）。
- 全局类名/全局对象：`CdifUtil`、`CdifDevice`、`CdifError`、`DeviceError` → 新命名。注意这些是暴露给第三方模块的 API 面，改名即 breaking change，正好随大版本一起做，并写 migration 说明。
- `error-info.zh-CN.json` 保留与否取决于是否继续支持 i18n；开源首发建议只留 en-US，减少表面积。
- **注意**：按"新名字 + 公开起源"方案，README 中保留一段 origin 说明（"evolved from the author's CDIF framework (2015)"），链接旧 repo。清理的是品牌噪音，不是历史。

---

## 三、依赖现代化（P1）

| 依赖 | 现状 | 目标 | 原因 |
|---|---|---|---|
| ajv | ^4.8.2 | ^8.x | draft-04 → 2020-12。**MCP 生态使用 JSON Schema 2020-12，这是 schema 层的核心改造**。api.json/schema.json 里的 `$schema: draft-04` 声明与 `id` 关键字（→`$id`）需要迁移脚本 |
| jsonwebtoken | ~5.4.0 | ^9.x | 已知算法混淆 CVE，必修 |
| express | ~4.13.3 | ^4.21+（或评估 5.x） | 安全补丁 |
| ws / express-ws | ^1.0.1 | ^8.x | 古老版本，安全+性能 |
| body-parser | ~1.14.0 | 内置 express.json() | 精简 |
| async | ^1.5.2 | 原生 async/await 渐进替换 | 可读性；不强求一次完成 |
| bull | ^3.20.0 | bullmq | bull 已维护模式；Tasks 扩展将建在其上 |
| nano (CouchDB) | ^6.2.0 | 随 P0-2 (c) 方案处理 | 降低安装门槛 |
| mkdirp/fs-extra/chmodr 等 | - | 原生 fs.promises | 精简依赖树 |
| devDeps: javascript-obfuscator, webpack-obfuscator, uglify-* | 存在 | **删除** | 商业分发遗留；开源信誉负资产 |
| mocha 5 / should / supertest 1.x | 古老 | mocha 10+ 或 node:test | 测试基础设施 |

- 增加 `"engines": { "node": ">=20" }`；CI 用 GitHub Actions 跑 20/22。
- `npm audit` 清零作为 P1 完成标准。

## 四、MCP 网关层（P1，新代码）

新增 `lib/mcp/`：
1. **Streamable HTTP transport**，对齐 2026-07-28 无状态规范（旧 HTTP+SSE 已官方弃用，不要实现）。
2. **tools/list**：遍历已加载模块的 spec，把每个 (device, service, action) 展开为 tool。命名建议 `moduleName.actionName`（serviceID 太长时截断策略要定）。inputSchema 直接使用已解引用的 input object schema；**outputSchema 也一并暴露**（我们有现成的，生态里少见，是差异化点）。tool description 取 action 的 description 字段——**当前描述语言中该字段非强制，改为强制并为示例模块补齐**（LLM 消费质量的关键）。
3. **tools/call** → 内部 invoke-action 路径，schema 校验失败返回结构化 MCP error（isError + 校验详情），保留"校验错误可喂回模型重试"的反馈质量。
4. **Tasks 扩展**：把 job-control 映射到 Tasks（创建/查询/取消/历史）。这是"2015 年设计对上 2026 年协议"叙事的第二个实锤。
5. 注册到官方 registry（registry.modelcontextprotocol.io）所需的 server.json 元数据。
- **验收**：MCP Inspector 连通；Claude Desktop/Code 作为客户端实际调用 echo 模块全流程成功；一条命令 demo。

## 五、安全证据文档（P1，与代码并行）

写 `docs/security-model.md`（英文），诚实框架：
- **威胁模型**：多租户运行不可信 npm 模块，worker_threads 提供的隔离边界是什么（独立 V8 heap/执行上下文），**明确不提供的**：OS 级隔离、原生模块逃逸、`process` 全局的可达性、资源耗尽（CPU 抢占）。
- 当前缓解措施盘点：package integrity verifier（verify-module）、schema 校验入口、redis 命令白名单（supported-redis-commands.json 是好素材）。
- 与 container / gVisor / micro-VM / V8 isolate (Cloudflare workerd) 的诚实对比表：隔离强度 vs 密度/冷启动/成本。
- 结论定位建议："worker-thread 隔离 + 模块审核（verify/publish）组合"适合半信任市场模型（模块经平台审核后上架），不宣称等同硬隔离。给出 roadmap：可选的 per-worker 资源限额、seccomp/landlock 或容器外壳的混合模式。
- **原则**：诚实的边界声明在 HN 存活率远高于夸大宣称；这份文档本身就是内容营销素材。

## 六、货币化接口抽象（P2）

- 把 session/redis 中的计量点抽象为 `MeteringProvider` 接口：recordCall(apiKey, tool, cost) / checkBalance / rateLimit。
- 内置实现：现有 Redis 方案。预留出口：x402（HTTP 402 + USDC）、Stripe MPP。**第一版只做接口 + Redis 实现 + 一个 x402 的 PoC 出口**，不铺开。
- Demo 目标（对话 Kong/Cloudflare/Stripe 的硬资产）："agent 调用平台上第三方模块 → 按调用扣费 → 开发者分成账目可查" 的最小闭环录屏。

## 七、内容与发布（P2，代码达标后）

1. README 重写（英文）：定位一句话 → 30 秒 quickstart → 架构图 → origin 段落（2015 起源 + 趋同进化一句话）→ security model 链接。
2. 技术博客：《We built MCP's tool architecture in 2015 — by accident》主线：UPnP → 单 object in/out 收敛（allowSimpleType）→ 与 MCP 同构的发现/调用/校验回路 → 十年后接上 agent 生态。我出全文初稿。
3. Show HN 发帖 + 首日答疑口径准备（预判问题：vs FastMCP/Metorial、worker 隔离够不够安全、为什么不用 TypeScript、和 CEAMS 什么关系——最后这个的回答口径：曾支撑作者的商业产品多年，本次以 Apache 2.0 全新品牌开源）。
4. 注册官方 MCP Registry；提交 awesome-mcp-servers / awesome-mcp-gateways 收录 PR。

---

## 八、Claude Code 施工顺序建议

```
Sprint 1（本周）:  P0-1 license → P0-3 rename（全局）→ P0-2 依赖替换
                  验收: 干净环境 install+test 全绿, 零 apemesh/cdif 残留(除 origin 声明)
Sprint 2:         P1 依赖升级(ajv 迁移优先) → CI 建立 → npm audit 清零
Sprint 3:         P1 MCP 网关 + Inspector/Claude 客户端联调
Sprint 4:         P1 安全文档 + P2 计量接口抽象 + x402 PoC
Sprint 5:         P2 README/博客/Show HN
```

## 附：审计中记录的小项
- `contributors.txt` 内容需检查，确认无公司主体贡献者表述。
- `docker/cjcg/`、`pre-installed-packages/lingyi-fire-control-data-module/` 为客户痕迹，删除。
- commit 历史含 `mchen@apemesh.com` 邮箱（49/52 commits）：不影响版权（唯一自然人作者），尽调被问时如实说明即可；新 repo 若想完全干净可考虑 squash 首发（trade-off：丢失"十年历史"的 git 证据，**不建议**——历史本身是卖点）。
- `binary-test.js`、`adaptive-test/`、`perf/` 保留，性能基准（>2500 TPS/core 的口径）需要在现代 Node 上重跑并把方法学写进 README，才能公开引用。

---

# 状态记录（2026-08-07 更新）

## Sprint 1：已完成 ✅
5 个 commit（d088151 修复 test019 既有 BSON 崩溃 → cd7c2b3 P0-2 device-db 并入 lib/device-db.js、移除私有 registry → 20ec00f P0-1 license 修正 Apache-2.0 → b23a94a P0-3 全局 rebrand + 客户目录删除 + API 面改名 + MIGRATION.md → c155c80 修正误提交）。67 个功能测试全绿（test7 性能基准按惯例排除）。

## 新增遗留问题（按优先级）

### P0-4 凭证泄露【紧急，进入 Sprint 2 前处理】
- **事实**：docker/cdif/Dockerfile（现 docker/mcpforge/Dockerfile）曾硬编码私有 registry auth token。该文件在公开的 mchen6/cdif 仓库中已存在多年——**属于已公开泄露，不是潜在泄露**。当前 commit 已移除，但 git 历史中仍在。
- **行动**：
  1. 确认 public-reg.apemesh.com:8080 是否仍在线。在线 → 立即吊销/轮换 token 并检查滥用痕迹；已下线 → 实质风险归零，仍执行下述清理。
  2. 全历史密钥扫描：gitleaks 或 trufflehog 跑一遍，确认无其他遗漏（token、password、内网 IP 等）。
  3. 公开新仓库前：git-filter-repo 定点清除含 token 的 blob（--replace-text 方式），其余历史完整保留。副作用：全部 commit hash 改变——发布到新仓库，可接受。旧 mchen6/cdif 仓库的处置（保留/归档/加 README 指引）单独决定。
- **验收**：gitleaks 全历史扫描零告警。

### P0-5 项目名重命名【已定名：countinghouse】✅ 决策完成，待执行
- **背景**：Sprint 1 中临时选用的 mcpforge 与 GitHub Richardmsbr/mcpforge（MCP 架构模式框架，npm 包名已占）直接冲突，必须更换。
- **定名**：**countinghouse**（旧时商行账房——商户的交易在此记录、核算、结算，与"MCP 工具的计量与结算后端"定位语义直接对应）。
- **已核查**：npm registry 404（可用，2026-08-07 验证）；GitHub org/用户名可用（用户人工验证）。
- **待核查（低风险，发布前完成即可）**：域名（countinghouse.dev / .sh / getcountinghouse.com；countinghouse.com 大概率被占，非必需）；USPTO 商标粗查 Class 9/42。通用英语词，商标冲突风险低。
- **执行**：Claude Code 复用 Sprint 1 的 rename 流程做 mcpforge → countinghouse 全局替换，一个 commit。范围包括：package.json name、全局类名（**已定：短前缀方案** McpForgeUtil/McpForgeDevice/McpForgeError → CHUtil/CHDevice/CHError）、HTTP header（→ X-CH-Key）、docker/ 目录名、MIGRATION.md 记录更新。
- **CLI 长度缓解**：bin 入口注册主名 countinghouse + 短别名（建议 `cth`），package.json bin 字段双写即可。
- **抢注动作（定名后立即，先于代码 rename）**：npm 上发布一个 0.0.1 占位包（README 一句 "reserved, coming soon"）锁定包名；注册 GitHub org。包名先到先得，一天都不要等。
- **验收**：npm 包名归属本人；仓库内 grep -ri mcpforge 零残留（MIGRATION.md 的历史记录除外）。

### P2 项（补充进 Sprint 4/5 范围）
- **i18n**：en-US locale 补齐缺失的 26 个 key → 测试断言改为 locale 无关（断言 error code 而非文本）→ 再决定 zh-CN 去留。Sprint 1 中推迟处理，判断正确。
- 上述 P0-4 的旧仓库处置决定（建议：归档 + README 顶部一句话指向新项目，保留作为 origin 证据）。

## Sprint 2：npm audit 清零（2026-08-08）

`npm audit --omit=dev` 从 31 个生产依赖 high/critical 清零到 0（仅剩 7 个 moderate，逐项见下）。逐依赖单独 commit，每次先验证 API 兼容性（scratch probe）再落地，测试全绿后提交：

| 依赖 | 处理 | 备注 |
|---|---|---|
| morgan | **删除** | require 了但从未 `app.use()`，死代码 |
| tar | 2.2.1 → 7.5.22 | `tar.Parse()` → `new tar.Parser()`，事件面/entry.type 字符串不变 |
| body-parser-xml | 1.1.0 → 2.0.5 | `express.xml()` 扩展 API 不变 |
| sqlite3 | 5.1.7 → 6.0.1 | 移除 node-gyp/cacache/make-fetch-happen 整条建链依赖；**本机 glibc 2.35 < 6.x 预编译二进制要求的 2.38，需 `--build-from-source`**（CI 的 ubuntu-latest glibc 更新，预期无需此参数） |
| soap | 0.24.0 → 1.6.4 | `soap.createClient(url, opts, cb)` 签名不变 |
| socket.io | ~1.5.0 → 4.8.3 | 唯一改动：`socketio.listen(server)` → `new socketio.Server(server)`；其余 API（`io.sockets.on('connection')`、`io.to(id).emit()`）不变。**联调时发现一个与本次升级无关的既有 bug**：见下"已知问题"一节 |
| redis | 2.6.3 → 3.1.2 | 关键判断：GHSA-35q2-47q7-3pc3（monitor 模式 ReDoS）漏洞区间是 `2.6.0-3.1.0`，3.1.2 已在区间外且 **早于 v4 那次破坏兼容的重写**（v4 起 callback API 全部改 Promise、createClient 签名改变、pub/sub 语义改变）。3.1.2 对现有 10 个文件的调用方式（`createClient(url,{db})`、`.get/.set/.hset/.multi().exec()`、`.subscribe/.on('message')/.publish`）完全零改动兼容。npm audit 建议的 fixAvailable（6.2.0）不是最小修复，只是"最新版"——审计建议不能直接照抄，要对着漏洞区间自己核实 |
| request | **替换为 postman-request** | request 的 SSRF 平流（GHSA-p8p7-x288-28g6）区间是 `<=2.88.2`——即所有已发布版本，因为官方选择弃用整个包而非修复。postman-request 是维护中的 API 兼容 fork，`request(opts, cb)` 签名、`json:`/`response.statusCode`/`body` 行为完全一致（已用真实 HTTP server + 现有 opts 结构验证）。`lib/countinghouse-util.js` 和 `lib/service-client.js` 的 `require('request')` 直接替换 |
| qs（postman-request 的嵌套依赖） | npm `overrides` 强制 `^6.15.2` | postman-request 自身 `package.json` 声明 `qs: ~6.14.1`，被单独 install 成 `node_modules/postman-request/node_modules/qs@6.14.2`（落在漏洞区间 `6.11.1-6.15.1` 内），即使顶层 `node_modules/qs` 已经是安全版本也不受影响——这是"顶层看着没事，嵌套拷贝仍中招"的典型例子，加一条 `overrides: {"qs": "^6.15.2"}` 强制全树统一后嵌套拷贝也被提升到安全版本 |

## 依赖风险接受清单（无法/不适合修复，记入风险登记）

以下条目**有可用修复版本，但审慎评估后判定升级成本/风险 > 实际暴露风险**，或**确无可用修复**，本轮不推进，记录理由供后续复核：

- **nano（^6.2.0，未跟进到 11.0.6）**：nano 自身依赖的 `request@^2.85.0` 曾是仅剩的生产 critical/high 来源，已通过 npm `overrides` 把该条也别名到 postman-request 解决（见上表，不算风险接受）。真正未处理的是 nano 版本本身：Sprint 2 中曾把 nano 升到 10.x/11.x，经过干净的 A/B 测试确认会破坏 `lib/service.js` 基于 Node 已废弃 `domain` 模块的异常捕获（nano 新版基于 Axios 的 HTTP 客户端与 `domain` 模块交互异常，即使代码路径完全不重叠也会触发），已回退并记入 memory（`project_domain_module_fragility`）。要安全升级 nano 需要先把 service.js 的异常处理从 `domain` 模块迁移掉——这是一次独立的、有意义的重构，不适合夹在安全审计 sprint 里仓促做。当前 nano 相关剩余发现均为 moderate（cloudant-follow、nano 本身），不在"清零"范围内。
- **lodash（^4.17.20，无修复版本）**：审计标记的漏洞函数为 `_.template`（模板注入）、`_.unset`、`_.omit`（原型污染）；经 grep 核实，全仓库仅使用 `_.intersection`、`_.isEqual`、`_.merge`（redis-api.js 的 supported-commands 交集运算等），三个高危函数从未被调用。当前 4.17.x 分支官方无进一步修复计划。风险接受：暴露面为零。
- **npm-registry-client（^7.2.1，无修复版本）**：官方已弃用、无后续版本；仅被 `/verify-module` 这条本就未纳入自动化测试、仅供开发调试用的路由使用。moderate，风险接受。
- **uuid（`<11.1.1`，经由 postman-request 和 rolling-rate-limiter 两条链路引入，moderate）**：漏洞描述明确是"`v3/v5/v6` 传入 `buf` 参数时缺少边界检查"——即只有显式传自定义 buffer 写入位置时才可触发。逐一检查了两个消费方的实际调用：`node_modules/postman-request/{request,lib/multipart,lib/oauth,lib/auth}.js` 全部是裸调用 `uuid()`（`require('uuid').v4`，无参数）；`node_modules/rolling-rate-limiter/index.js` 同样是裸调用 `uuid()`（`require('uuid/v4')`，无参数）。两条链路都从未传 `buf`，漏洞代码路径不可达。未强制 `overrides` 升级 uuid 到 11.1.1+：`rolling-rate-limiter` 用的是 `require('uuid/v4')` 深子路径导入，新版 uuid 是否仍导出这个子路径未经验证，强制全局 override 有弄坏这条从未出问题的依赖链的风险，对一个不可达的 moderate 漏洞不值得冒这个险。风险接受。
- **rolling-rate-limiter（^0.1.10，实际解析到 0.1.11，无缝 minor 修复版本）**：npm audit 给出的 `fixAvailable`（0.1.7）比当前版本还低，明显不是真实修复建议（同类问题在 redis 那条也出现过——审计的 fixAvailable 字段不能直接采信）。0.4.2 虽然把 `uuid` 升到 `^9.0.0`，但 9.x 仍然 `<11.1.1`，一样会被标记，升级换不来实质收益，且 0.2.0+ 起始终有 API/依赖变动需要验证。留在 0.1.11，风险接受理由同上（uuid 调用路径不可达）。

**验收结果**：`npm audit --omit=dev` → 0 critical，0 high（仅剩 6 moderate，均如上说明：nano/cloudant-follow、npm-registry-client、postman-request/uuid、rolling-rate-limiter/uuid）。

## 已知问题（非本轮安全升级范围，记录以便后续修复）

- **`lib/socket-server.js` 的 eventSubscribe 参数不匹配**：`socket-server.js` 调用 `cdifInterface.eventSubscribe(subscriber, deviceID, serviceID, device_access_token, session)`，只传了 5 个参数；而 `CdifInterface.prototype.eventSubscribe`（`lib/countinghouse-interface.js:120`）签名是 `(deviceID, serviceID, actionName, input, inputKey, token, callback)`，需要 7 个。结果 `subscriber` 对象（内含 `io` Server 引用）错位落入 `deviceID` 位置，构造 `DEVICE_NOT_FOUND` 错误信息时对其 `JSON.stringify` 触发循环引用异常崩溃。这是 socket.io v4 升级联调时才发现的**既有缺陷**（`sioServer` 是 opt-in 功能，从未被自动化测试覆盖过，与本次版本升级本身无关，git diff 已确认升级只改了 `socketio.listen()` → `new socketio.Server()` 一行）。未在本轮修复，留作后续任务。
- **~~MCP task-augmented `tools/call` 完全跳过 userAuth（设备归属校验）~~【2026-08-09 已修复，已补测试】**：`lib/mcp/gateway.js` 的 `createTaskForToolCall` 在任务创建时只调用 `rateLimit`，从未调用 `userAuth`；任务执行侧（`lib/job-control.js` 的 worker → `cdifInterface.invokeJobs` → `DeviceManager.prototype.onInvokeJobs`，`lib/device-manager.js:643`）签名里根本没有 appKey/token 参数可供校验。同步 `tools/call` 路径在 `gateway.js:143` 有这一步，task 路径没有。结果：任何 apiKey（不需要真正拥有该设备的访问权）task-augment 一次调用即可执行成功——这是一个真实的授权绕过，不只是体验缺陷。构建 `docs/cross-cutting-matrix.md` 过程中发现。**修复**（commit `7a67d2d`）：`createTaskForToolCall` 现在先调用 `userAuth`（与同步路径同一套 `JSONRPC_INTERNAL_ERROR` 失败形状，检查点位置与 `rateLimit` 早前的修复一致——task 创建时），通过后再走原有的 `rateLimit` 检查 + `doCreateTaskForToolCall`；返回的 `session` 直接丢弃，任务执行仍走原有的 `JobControl.addJob`/`invokeJobs` 路径不变。**测试**（commit `a003613`）：`test/unit/test031.js`——无权 apiKey 走 task 路径调用被拒且不创建 task；有权 apiKey 仍正常创建并成功执行；单线程模式下（tasks 本不支持）自动跳过该断言，改用 `initialize` 返回的 `capabilities.tasks` 判断而非假设固定线程模式。`test1`–`test5` 全部通过（34/34，较之前的 30/30 多出本文件的 4 个断言）。
- **~~MCP `tools/call` 的错误响应丢失 `code` 字段~~【2026-08-09 已修复，已补测试】**：`gateway.js` 的 `toolCallResult()` 错误分支只把 `err.message` 序列化进 `content[0].text`，从未包含 Sprint 4 新增的、与 locale 无关的 `err.code`。HTTP `invoke-action` 的 JSON 错误体（`lib/session.js`）包含 `code`；MCP 的两条 `tools/call` 子路径（同步 + task-augmented，共用同一个 `toolCallResult()`）都不包含。构建 `docs/cross-cutting-matrix.md` 过程中发现。**修复第一层**（commit `7a67d2d`）：`toolCallResult()` 现在在 `err.code` 存在时把它放进 `structuredContent: {code: err.code}`。补测试（commit `44c2bf8`）时又连带发现并修复了两个更深的问题，同一症状不同根因：
  1. **`job-control.js` 的 worker 只把失败原因存成纯字符串**（bullmq `job.failedReason = err.message`），任何自定义属性——包括 `code`——在写入 redis 前就已丢失，与 `toolCallResult()` 本身无关。修复：worker 在原始错误带 `code` 时，把 `"CODE: message"` 编码进 reject 的消息里（`CHError`/`DeviceError` 的 `code` 都是 `UPPER_SNAKE_CASE`，真实消息不会以这种格式开头，不会误判）；`handleTasksResult` 解码这个前缀还原出 `err.code`。
  2. **`JobControl.getJob` 里一个此前未被发现的既有竞态**：`job.getState()`（bullmq 内部走独立的 redis 读取）与前面 `jobQueue.getJob(id)` 取到的 `job` 实例是两次分开的读取，`getState()` 从不刷新 `job` 实例自身字段；如果 job 在这两次读取之间恰好进入终态，`getJob` 返回的 `failedReason`/`returnvalue` 仍可能是转变前的空快照，即使 `state` 已经正确显示为 `'failed'`——表现为 `tasks/result` 偶发返回泛化的 `"task failed"` 兜底文本而非真实原因。这个问题与本轮 `code` 修复无关，在这之前就可能静默发生，只是此前没有测试断言足够严格到会注意到。是在完整套件里跑 `test032.js`（前面已有 30+ 个测试给同一个 redis/bullmq 实例带来真实负载）时才复现的，单独隔离跑不出来。修复：`state` 落定为终态后，`getJob` 重新拉取一次 job 数据。

  **测试**（commit `44c2bf8`）：`test/unit/test032.js` 断言同步路径与（tasks 受支持时）task-augmented 路径经 `tasks/result` 轮询后均能拿到 `structuredContent.code === 'INPUT_DATA_VALIDATION_FAIL'`。竞态问题额外用一个 40 并发失败任务的压测脚本验证（未收入正式测试套件，因为这是负载相关的确认而非确定性单测）：修复后 40/40 都正确带上 `code`，0 次命中泛化兜底文本。`test1`–`test5` 全部通过（34/34）。

## Sprint 3：MCP 网关层（2026-08-08 ~ 2026-08-09）

新增 `lib/mcp/`（`gateway.js` JSON-RPC 分发 + `tool-registry.js` spec→tool 转换）与 `lib/routes/mcp.js`，对齐"四、MCP 网关层"五项：

1. **Streamable HTTP 无状态传输**：仅 `POST /mcp`，`GET /mcp` 返回 405（不实现已弃用的 HTTP+SSE）。
2. **tools/list**：遍历已加载模块 spec，`(device, service, action)` 展开为 tool，命名 `friendlyName_serviceLabel_actionName`（去重后缀防冲突）。inputSchema/outputSchema 均通过既有 `getDeviceSchema` 通道解引用暴露（worker-thread 模式下也正确工作，因为这是唯一能拿到 worker 内 schemaDoc 的路径）。action `description` 改为强制项——缺失则跳过该 tool（记日志，不整体失败）；echo-device-module 16 个 action、echo-device-client-module 2 个 action 的占位中文描述已全部替换为真实英文描述。
3. **tools/call** → 内部 `invokeDeviceAction` 路径。
4. **Tasks 扩展**：`job-control.js`（bullmq）映射到 `tasks/get`、`tasks/result`、`tasks/list`、`tasks/cancel`，以及 `tools/call` 的 `task` 参数增强（任务化调用）。仅 `--workerThread` 模式下 `initialize` 才声明 `capabilities.tasks`。过程中发现并修复了 `job-control.js` `removeJob` 的既有 bug：`job.remove()` 返回的 promise 从未被等待/捕获，导致对"被 worker 锁定的活跃 job"取消操作会静默谎报成功；修复后活跃 job 取消正确返回错误，已完成 job 取消仍正常成功。
5. **server.json**：仓库根目录，对照 registry.modelcontextprotocol.io 的**实时** schema（`https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json`，用 ajv 校验通过）编写，而非凭记忆——本轮过程中已发现一次协议细节记忆过时（见下）。

**协议版本号发现**：实测（通过 npx 拉取的真实 `@modelcontextprotocol/sdk`）显示当前 SDK 的 `LATEST_PROTOCOL_VERSION` 是 `2025-11-25`，其 `SUPPORTED_PROTOCOL_VERSIONS` 列表里没有 `2026-07-28`——MCP Inspector 一度直接拒绝连接。由于本实现的请求/响应处理完全不依赖 protocolVersion 分支（tools/list、tools/call 等在任何版本下形状相同），改为 `initialize` 时原样回显客户端请求的版本号（客户端未指定时才回退到 `2026-07-28`），成本为零且更符合协议本身的版本协商语义。**这里的 `2026-07-28` 是施工图/CLAUDE.md 里给定的目标版本号，与已验证的 SDK 实测结果不一致，值得回头核实一下这个日期的原始出处**（可能是尚未发布的未来版本，也可能是记忆/口径误差）。

**验收结果**（施工图原文："MCP Inspector 连通；Claude Desktop/Code 作为客户端实际调用 echo 模块全流程成功"）：**两项均已达成，非自证**——
- MCP Inspector：`--cli` 模式验证 `tools/list`/`tools/call`；发现其无 `tasks/*` 支持后，改用其 Web UI 后端真实 API（`/api/mcp/connect` + `/api/mcp/send` + SSE `/api/mcp/events`，即浏览器 UI 底层实际调用的同一套 `@modelcontextprotocol/sdk` client）驱动了 `initialize`（协商 tasks 能力）→ 任务化 `tools/call` → `tasks/get` 轮询 → `tasks/result` → `tasks/list` → `tasks/cancel`（含锁定态失败与已完成态成功两条路径）全流程，均通过。
- Claude Code：用户在独立终端启动服务器（`--workerThread --debug --bindAddr 127.0.0.1 --port 9527`），`claude mcp add --transport http countinghouse http://127.0.0.1:9527/mcp` 注册，新开 Claude Code 会话后 `/mcp` 确认已连接，自然语言指令调用 `mcp__countinghouse__echo_device_echoservice_echo`，**用户确认回显结果正确**——这是施工图要求的、由真实客户端（而非本会话自造的探针脚本）完成的全流程验证。

## 协议版本号核实结论（2026-08-09，回应 Sprint 3 记录中的存疑项）

**`2026-07-28` 版本号真实且已定稿**：该规范 5 月 21 日锁定 RC、经约十周验证窗口后于 2026-07-28 如期定稿发布，正式取代 2025-11-25 成为当前版本（来源：blog.modelcontextprotocol.io 官方发布文与 changelog）。官方声明四个 Tier 1 SDK 定稿当天支持新版本。CC 实测到 SDK `LATEST_PROTOCOL_VERSION: 2025-11-25` 的原因：Inspector 捆绑/锁定的是旧版 SDK 依赖，npx 缓存也可能拉到旧包——生态工具跟进滞后于规范定稿（仅两周），属预期现象，非施工图口径错误。

**结论与动作**：
- 现有实现（回显客户端协商版本 + 无状态核心 + 兼容旧客户端 initialize）**保持不变**——新规范移除了协议级 session/initialize，但弃用项有 ≥12 个月保留窗口，双轨行为正好落在窗口内。
- 新增低优先级跟踪任务：每隔几周核查 @modelcontextprotocol/sdk 与 Inspector 的正式版是否已支持 2026-07-28；生态跟上后把默认回退版本从当前值重新评估。README/博客中表述为 "implements the stateless 2026-07-28 revision, with graceful negotiation for older clients"。
- 复盘一条方法论（CC 本轮做得对，记下来沿用）：协议细节以实测和官方 schema 为准，不信记忆——server.json 对照实时 schema 校验、协议版本用真实 SDK 验证，都是正确做法。

## Sprint 4 完成状态确认（2026-08-09，逐项核对）

对照"五、安全证据文档"与"六、货币化接口抽象"，逐项核实（非自证——检查了实际文件/git 历史，不是照抄任务清单）：

| 项目 | 状态 | 证据 |
|---|---|---|
| `docs/security-model.md`（英文，威胁模型） | ✅ 完成 | 文件存在（10412 字节）；commit `548ba85`。内容对照 `lib/sandbox.js`（无 `resourceLimits`）、`lib/routes/verify-module.js`（仅结构校验非签名验证）、`lib/supported-redis-commands.json`（白名单不含 flushall/config/eval 等）落笔，非泛泛而谈 |
| `MeteringProvider` 三接口（`recordCall`/`checkBalance`/`rateLimit`） | ✅ 完成 | `lib/metering/provider.js`（接口）+ `redis-provider.js`（默认实现）。HTTP invoke-action 路径（`lib/session.js`、`lib/countinghouse-interface.js`）与 MCP 网关（`lib/mcp/gateway.js`）**两条入口均已挂接全部三个方法**：commit `d131525`（接口+Redis 实现+x402 PoC）、`0a8e4bf`（接入 HTTP 路径）、`d4fc94b`（`GET /balance` 路由）、`fe2e273`（`checkBalance` 接入 MCP，平台 tool `countinghouse_check_balance`）、`ad55c99`（`recordCall` 接入 MCP，同步+task-augmented 两条子路径）、`0cd1350`（`rateLimit` 接入 MCP，同步+task-augmented 两条子路径，其中 task-augmented 子路径是过程中新发现的缺口，修复前先用 curl 实测复现） |
| x402 PoC 出口 | ✅ 完成（按施工图定义的"仅 PoC"范围） | `lib/metering/x402-provider.js`：`recordCall` 总是抛 `X402PaymentRequiredError`（附 amount/currency/network/payTo challenge），`checkBalance` 返回 `{balance: null, model: 'pay-per-call'}`，`rateLimit` 恒返回未限流。刻意不做 facilitator 对接/链上校验——这是施工图原文"第一版只做接口 + Redis 实现 + 一个 x402 的 PoC 出口"的字面范围，未扩大 |
| `lib/socket-server.js` eventSubscribe 参数错位 bug | ✅ 修复 | commit `28474f5`。修复参数顺序错位 + 把 `Session` 实例误传作 callback 的问题；同时发现并记录一个更深的既有缺陷（`subscriber.publish` 从未被挂载为 `serviceevent` 监听器，事件推送链路本身不完整）——按范围纪律**只修参数 bug，未扩大到重建整个事件推送链路**，缺陷已记入本文档"已知问题"一节 |
| en-US locale 补齐 + 测试断言 locale 无关 | ✅ 完成（范围超出原始 26 个 key） | commit `bc06bd9`。核实脚本确认：zh-CN 与 en-US 均 112 key，完全对齐；en-US 全部 112 条值均无中文字符残留（非仅补 26 个缺失 key——原有 86 个 key 实测发现也仍是中文，经用户 AskUserQuestion 确认后一并完整翻译）。同时给 `CHError`/`DeviceError` 新增 locale 无关的 `code` 字段，24 个 `test/unit/testNNN.js` 断言改为判断 `code` 而非 `message` 文本；过程中发现并修复了一个更深的 bug：worker_threads 消息边界只传递 `err.message`，从不传递 `err.code`，导致跨 worker 的错误重新包装后 `code` 字段被格式化后的文本污染（修复见 `lib/worker-message.js`） |

**结论**：Sprint 4 五项全部完成，无遗留。过程中发现的三个"顺带缺陷"（socket-server 事件推送链路不完整、worker 边界 code 丢失、job-control removeJob 静默成功——最后一项发现于 Sprint 3）均已分别记入相应位置，未在本轮修复范围外的部分不打算掩盖或补做，如实标注为已知问题。

---

# 新增任务（2026-08-09 补充，Sprint 5 范围）

## P2-复合工具：进程内工具组合 + 组合内计量 demo

**背景与定位**：agent 串联多个工具时，每个中间结果都要经模型上下文往返（token 成本、延迟、注意力稀释三重浪费），生态的应对方向是服务端组合（code execution / code mode）。countinghouse 的模块间 worker message channel 调用是现成的服务端组合基础设施，且叠加独有的一层：**内部调用也是计量点**，可支撑模块开发者之间的分成链。这是首发博客中预告的 follow-up 主题（《Composite MCP tools with metered internal calls》），也是未来对 Kong/Stripe/Cloudflare 演示的核心素材。

**任务内容**：
1. **Demo 复合模块**：编写一个示例模块 `composite-demo`，对外暴露一个 tool；内部通过 worker message channel 依次调用同平台的另外两个示例模块（如 echo + 一个简单变换模块），中间数据不出进程、不经模型上下文。外部视角：一次 `tools/call` 完成全链路。
2. **组合内计量**：MeteringProvider 的 recordCall 下沉覆盖 message channel 内部调用——复合工具每次执行产生完整的分账记录（外层调用方付费 → 内层各模块开发者按各自费率入账）。demo 输出一份可读的调用链账单（JSON 即可，无需 UI）。
3. **表述纪律**（写文档/博客时遵守）：这是**平台能力**而非 MCP 协议扩展，表述为 "countinghouse makes hosted tools composable"，不用 "we extended MCP"；性能优势的准确说法是"免去 HTTP 栈/网络往返/模型上下文往返的进程内组合"，**旧的 20–30x 数字在现代 Node 重跑 benchmark 之前不得公开引用**（与"附：小项"中 perf 基准条目同一要求）。
4. **验收**：Claude Code 作为客户端调用复合 tool 一次成功；调用链账单显示 ≥2 个内层模块的独立计量记录；docs/ 下有一页 composite-tools.md 说明机制与边界。

## 新增小任务（2026-08-09，源自 Sprint 4 的缺陷模式复盘，纳入 Sprint 5）

**横切关注点覆盖矩阵（docs/cross-cutting-matrix.md，英文）**：Sprint 3/4 连续三次发现"新入口路径遗漏横切关注点"类缺陷（removeJob 静默成功、task 路径 recordCall 缺口、task 路径 rateLimit 缺口）。建立矩阵文档：行 = 入口路径（HTTP invoke-action、MCP tools/call 同步、MCP task-augmented、事件通道、未来的 direct peer channel），列 = 横切关注点（userAuth、schema 校验、recordCall、rateLimit、超时、错误形状），格 = 实施代码位置或"豁免 + 理由"。当前状态先如实填写，空格即待办。此后任何新入口路径的 PR 必须先更新此表。direct peer channel 的"内部调用是否限流"等语义决策在此表中给出并注明理由。

---

# Sprint 5 状态记录（2026-08-09）

## P2-复合工具 demo：✅ 完成

逐项对照本文档"新增任务"节的验收标准：

| 验收项 | 状态 | 证据 |
|---|---|---|
| Demo 复合模块，对外一个 tool，内部经 worker message channel 依次调用另外两个示例模块 | ✅ | 新增 `pre-installed-packages/transform-demo`（`uppercase` action，独立于 echo 的第二个内层模块，避免复合链路里两次调用同一个模块）+ `pre-installed-packages/composite-demo`（`compositeService/run`：先调 transform-demo 转大写，再把结果喂给 echo-device-module 的 `echo`）。两次内层调用都走既有的 `ServiceClient`/worker message channel 机制，未新增跨进程/HTTP 路径 |
| 组合内计量：recordCall 覆盖 message channel 内部调用，产生分账记录 | ✅ | 每个内层 hop 成功后由 `com-countinghouse-compositeService-run.js` 显式调用 `CHUtil.recordCall`，结果汇入 `bill` 数组随 tool 输出返回。为此修了一个真实平台缺口：`CdifInterface` 此前只在 `isMainThread === true` 时构造 `meteringProvider`，导致任何 device 模块自己的 worker 里调 `CHUtil.recordCall` 必然失败——现在无条件构造（`lib/countinghouse-interface.js`），`CHUtil.recordCall` 作为新导出方法接入（`lib/countinghouse-util.js`）。此修复不限于本 demo，任何模块现在都能在自己的 worker 里记账 |
| demo 输出可读的调用链账单（JSON 即可） | ✅ | `run` 的输出 `bill` 为 `[{hop, tool, charged, balance}, ...]`，人类可读，无需额外 UI |
| 表述纪律（平台能力而非协议扩展，20–30x 数字暂不引用） | ✅ | `docs/composite-tools.md` 开篇即用"countinghouse makes hosted tools composable"表述，明确写"不是 MCP 协议扩展"；全文未引用任何旧 benchmark 数字 |
| Claude Code 作为客户端调用复合 tool 一次成功 | ✅ | 实测：`--workerThread --debug` 起服务，加载 echo-device-module + transform-demo + composite-demo 三个模块，用 `@modelcontextprotocol/inspector --cli` 真实 MCP 客户端调用 `composite_demo_compositeservice_run`，返回 `finalText`（正确经两跳变换）与 `bill`（两条独立计量记录，`balance` 随连续调用正确递减），另有一次直接 `curl` JSON-RPC 调用交叉验证 |
| 调用链账单显示 ≥2 个内层模块的独立计量记录 | ✅ | `bill` 含 `transform-demo/uppercase` 与 `echo-device-module/echo` 两条独立记录，`tool` 字段可区分来源模块 |
| docs/composite-tools.md 说明机制与边界 | ✅ | 新增，含机制说明、表述纪律、计量设计、实测样例，以及一节"已知简化"如实列出未做的部分（外层调用方真实 apiKey 未透传到内层、per-hop 费用写死、meter 走 per-worker Redis 连接而非消息通道代理、跨 worker 调用路径本身没有中心化计量兜底——composite-demo 的记账是模块自己显式做的，不是平台级保证，与 cross-cutting-matrix 的定位呼应） |

**已知的、未在本次范围内解决的简化**（记入 composite-tools.md，未隐藏）：外层调用方的真实 apiKey 未穿透到内层 hop（demo 用固定内部身份 `composite-demo-internal`）；per-hop 价格写死为常量；`recordCall` 现在每个 worker 各自开一条 Redis 连接（`isMainThread` 门禁移除后的直接后果），未改造成走 `lib/redis-api.js` 那种消息通道代理模式。均标注为后续可做项，不影响本轮验收标准的通过。

**测试**：`npm test` 链路中 `test1`–`test5` 全部通过（`test1`/`test2` 各 30/30，`test3`/`test4`/`test5` 见提交记录）。过程中 `test2.js` 单独出现过一次 `test025`（"API log length mismatch"）失败，经隔离复现排查（在干净树上单跑 `test2.js`、`test1+test2` 链式跑，均稳定通过；恢复本次改动后再跑 `test1+test2` 链式，同样稳定通过）确认是一次性环境噪音（很可能是此前手动 smoke test 遗留的服务器进程/连接未完全清理所致），非本次改动引入的回归。

Commit：`f210274`。

## 横切关注点覆盖矩阵：✅ 完成

`docs/cross-cutting-matrix.md`（英文）：行 = 5 条入口路径（HTTP invoke-action、MCP tools/call 同步、MCP task-augmented、事件通道、direct peer channel/worker message channel），列 = 6 项横切关注点（userAuth、schema 校验、recordCall、rateLimit、超时、错误形状）。每一格都通过实际读代码核实（非凭记忆），非豁免格标注具体实现位置（文件+行号）。

构建过程中发现两个此前未知的真实缺口，如实记入文档（未在本任务范围内顺带修复，同时补记到本文档"已知问题"一节）：
1. **MCP task-augmented tools/call 完全跳过 userAuth**——任何 apiKey 都能 task-augment 一次调用并执行成功，无需真正拥有目标设备的访问权。这是一个真实的授权绕过，比另一项更严重，建议优先跟进。
2. **MCP tools/call 的错误响应丢失 err.code**——`toolCallResult()` 只序列化 `err.message`，HTTP 路径的 `code` 字段（Sprint 4 新增）对 MCP 客户端不可见。

按施工图要求，direct peer channel 的"内部调用是否限流"语义决策已在矩阵文档中给出并注明理由：**本轮不做**——目前唯一使用方 composite-demo 的调用方和被调方都由平台自己控制，还没有真正的第三方组合模块能利用这个缺口；且要限流对，需要先决定"内部一跳到底算谁的额度"，这本身是个设计问题（依赖 composite-tools.md 已记录的"外层 apiKey 未透传"简化），不该作为填表的副作用仓促决定。

Commit：`460763a`。

## 七.1 英文 README 重写：✅ 完成

对照施工图原文"定位一句话 → 30 秒 quickstart → 架构图 → origin 段落 → security model 链接"逐项核对：

| 验收项 | 状态 | 证据 |
|---|---|---|
| 定位一句话 | ✅ | 开篇加粗一句："countinghouse hosts your MCP tools, meters every call, and lets tools call each other in-process — so you can charge for what agents actually use." |
| 30 秒 quickstart | ✅ | `git clone` → `npm install` → `node ./framework.js --workerThread --bindAddr 127.0.0.1 --loadModule ...` → `claude mcp add` → 调用 echo tool。每条命令均实测跑过，非凭记忆——过程中发现初稿里的 tool 名称猜错了（写成 `echo_device_module_echoservice_echo`，实际 `tools/list` 返回的是 `echo_device_echoservice_echo`，因为 `friendlyName` 是 `"echo-device"` 不是 `"echo-device-module"`），已用真实 `tools/list`/`tools/call` 响应核实并改正 |
| 架构图 | ✅ | mermaid flowchart：MCP client → gateway/HTTP invoke-action → DeviceManager（主线程）→ 各 worker_threads.Worker（设备模块）→ MeteringProvider；并标出 worker 间 message channel 与"进程内组合"箭头（对应 composite-demo） |
| origin 段落 | ✅ | 独立"Origin"小节：明确写 2015 年 CDIF、UPnP 启发、以及"两个不相关问题收敛到相似形状"的一句话解释，未回避起源，同时按 CLAUDE.md 指示删除了指向已停用 apemesh/out4b 生态的旧驱动模块链接（品牌噪音而非历史本身） |
| security model 链接 | ✅ | 独立"Security model"小节，链接 `docs/security-model.md`，并给出一句话摘要（worker 隔离 vs 无代码级沙箱） |
| 不引用旧 20–30x 数字 | ✅ | 全文未出现任何性能数字 |

旧 README 是纯 CDIF 遗留内容（node v0.10.x 要求、apemesh/out4b 组织链接、端口 3049、完全没有 MCP 相关内容），做的是整体重写而非增量编辑。

Commit：`fe4802e`。

---

## Sprint 5 结论

三项任务（P2-复合工具 demo、横切关注点覆盖矩阵、README 重写）全部完成，各自独立 commit（`f210274`、`460763a`、`fe4802e`），过程中发现的四个"顺带缺陷"（meteringProvider 的 isMainThread 门禁、MCP task-augmented 路径缺 userAuth、MCP tools/call 错误响应丢失 code、以及矩阵文档记录的 direct peer channel 无限流现状）均未越界擅自修复——第一个直接修了（是 composite-demo 验收标准本身要求的），其余三个如实记入本文档"已知问题"一节和相应文档，留作后续任务。

---

# Direct Peer Channels 实施状态记录（2026-08-09）

按 `docs/direct-peer-channels-design.md` 第 5 节实现顺序执行，五项设计决策（D1–D5）不得偏离。每步单独 commit，全量测试要求 `--directPeerChannels` 开/关两态下均绿。

## Step 1（D1 端口拓扑 + D2 协议）：✅ 完成，commit `cdc9680`

新增 `lib/peer-channel.js`（PeerChannel 类，msgID/msgQueue 式请求-响应关联，独立 id 空间，per-call 超时）+ `lib/peer-channel-broker.js`（主线程 broker，惰性按对 brokering，`channelRegistry` 按 `callerWorkerId:calleeWorkerId` 缓存）。`workerId` 直接用 Node 原生 `worker.threadId`，未另造 ID 体系。`lib/service-client.js` 的 `isRemoteThread` 分支是唯一接入点，`options.directPeerChannels`（新 flag，默认关）决定走新路径还是原有 `sendActionInvokeMessageToParent`（关闭时该路径零改动，已用 `test1.js`/`test2.js` 68/68 通过核实）。

新增错误码（两个 locale 同步）：`PEER_GONE`、`PEER_CHANNEL_TIMEOUT`、`PEER_SELF_TARGET`、`PEER_NO_HANDLER`。

实测中发现并修复一个真实 bug（写完代码就跑，未等到测试才发现）：`sendPeerChannelOpenToChild` 把 port 放进了 transferList 但从未挂到 message 对象本身，导致接收端 `msg.port` 是 `undefined`，worker 内 `new PeerChannel(undefined, ...)` 抛异常。修复：显式 `message.port = port`。

测试：`test/direct-peer-channels/01-echo-roundtrip.js`，经新增 `test/test8.js`（复用 `test1.js` 模式 + `--directPeerChannels`）跑通——36/36（34 条既有 `test/unit/*` 断言 + 2 条新增）。尚未接入 `package.json` 的 `test` 脚本，这是 Step 5 的明确交付物。

## Step 2（D4 端口失效）：✅ 完成，commit `f4b2749`

失效机制本身（`PeerChannel.prototype.invalidate`、port 原生 `close` 事件双保险、`PeerChannelBroker.prototype.invalidateWorker`、`onPurgeDevice` 主线程分支挂载点）Step 1 就已建好，因为没有这些 `PeerChannel` 类本身不完整。Step 2 主要发现并补上了一个真实缺口：

`onPurgeDevice` 的主线程分支只能感知"主线程自己发起"的清除（外部 unload、worker 崩溃/exit）；**同一 worker 原地热重载**（`POST /load-module` 打到一个已加载的模块名，复用同一个 `Worker`/`threadId`，走 `ModuleManager.onModuleLoad` 的"模块重载"分支）清除发生在 worker 内部，worker 身份（workerId）从未改变，主线程完全无从得知。修复：worker 在本地清除设备后主动向主线程发一条新的单向消息 `peer-self-invalidate`，主线程收到后按已有的 `invalidateWorker` 逻辑处理。

验证方法：先手写脚本实测（`/restart-module` 触发的真实 worker 重建 + 并发调用竞态），确认失效是"快速失败"而非静默挂到 30 秒本地超时；再落成正式测试。过程中还发现 `01-echo-roundtrip.js` 用的 action（`服务名称/API名称`）会吞掉 `err`，会掩盖住 PEER_GONE 之类的信号，换成 `errTestService/testErrorInfo`（正确透传错误）才看到真实的 `PEER_GONE`/`DEVICE_NOT_FOUND` 序列。

测试：`test/direct-peer-channels/02-invalidation-on-restart.js`，建立通道 → 触发 `/restart-module` → 并发调用竞态（全部应在 5 秒内快速失败，而非接近 30 秒超时；至少一次应观察到 `PEER_GONE`/`DEVICE_NOT_FOUND`）→ 轮询确认新实例上重新建立通道后恢复正常（模块重新发现有固定 ~5 秒窗口，轮询而非固定延时）。`test8.js` 连跑两次确认非 flaky：37/37、37/37。`test1.js`/`test2.js`（flag 关）68/68 不受影响。

## Step 3（D3 鉴权前移）：✅ 完成，commit `5cc56bc`

同样，机制本身（`PeerChannelBroker.prototype.handleRequest` 里的 `userAuth` 一次性校验）Step 1 就已实现。Step 3 补的是拒绝路径的实测验证 + 正式测试 + 矩阵文档更新。

实测确认：把 `--debugKey` 设为与 `echo-device-client-module` 内置 `appKey`（`'aabbcc'`）不一致的值，brokering 请求正确、快速（个位数至两位数毫秒）返回 `SYSTEM_ERROR_UNKNOWN_USER`，未创建端口。

测试：`test/direct-peer-channels/03-grant-time-auth.js`——由于测试拒绝场景需要一个与共享 `test8.js` server（`--debugKey aabbcc`）不同的 `--debugKey` 配置，这个文件是独立自建 server（模式同 `test1.js`），单独用 `npx mocha test/direct-peer-channels/03-grant-time-auth.js` 跑，未接入 `test8.js` 的 sweep。连跑两次确认非 flaky：均 1/1 通过。

**已按用户要求同步更新 `docs/cross-cutting-matrix.md`**：原"Direct peer channel"一行实际描述的是旧的主线程路由路径（`isRemoteThread` 但走 `sendInvokeActionMessageToWorker`），现在 `--directPeerChannels` 真正实现后，这个名字被两条路径共用，如实拆成两行——"Direct peer channel — 主线程路由"（flag 关，默认，原行内容不变）与"Direct peer channel — `--directPeerChannels`"（flag 开，新行，记录 D3 的鉴权模型："possession of the port = authorization"，一次性按 (callerWorkerId, targetDeviceID) 检查，非每次调用检查）。限流格暂记"未启用"，理由与矩阵中已记录的决策一致（该决策未因 D3/D5 实现而重新讨论，见矩阵文档新增的"Update"说明）。recordCall 格标注"D5 尚未实现"，留到 Step 4 填写。

## Step 4（D5 计量上报）：✅ 完成，commit `aff57e2`

机制本身（`DeviceManager.prototype.onPeerChannelOpen` 的 `onInvoke` 闭包计时并上报 `peer-metering`；`PeerChannelBroker.prototype.handleMetering` 消费并调用 `CHUtil.recordCall`）Step 1 就已实现。Step 4 补的是实测验证 + 正式测试 + 文档更新，同时发现并如实记录了一个真实问题。

实测过程：
1. 用 echo-device-client-module（单跳，自己不做任何显式 `recordCall`）实测 `/balance` 余额在一次直连调用前后正确变化，确认 D5 机制本身工作正常。
2. 用 composite-demo（P2-复合工具 demo）实测复合工具账单——**首次测试用了错误的服务器配置**（`--debugKey aabbcc`，与 composite-demo 内置的 `appKey: 'composite-demo-internal'` 不匹配），导致调用全部失败于 `DEVICE_ACTION_CALL_FAIL`；用临时 `git worktree` 检出到本次 direct-peer-channels 工作开始前的 commit（`44c2bf8`）复测，同样失败，一度怀疑是回归——最终定位为纯粹的测试配置错误（Sprint 5 原始验证从未设置 `--debugKey`），换回不设 `--debugKey` 的配置后，复合工具在 `--directPeerChannels` 打开时**验收硬标准达标**：调用链账单正确显示 2 条独立计量记录（`transform-demo/uppercase`、`echo-device-module/echo`），P2-复合工具原验收未因本优化而放宽。
3. 精确测量余额变化时发现真实问题：**composite-demo 在 `--directPeerChannels` 打开时被重复计费**——`composite-demo-internal` 的余额一次两跳调用应变化 2×HOP_COST，实测变化 3×HOP_COST。原因：composite-demo 自己在每跳后显式调用 `CHUtil.recordCall`（Sprint 5 设计），现在平台又对同一跳自动上报计量（本 Step 新实现）——两者都记账，没有互斥/去重机制。composite-demo 自己的账单（`bill` 字段）不受影响，仍正确显示 2 条记录（不知道背后多收的费用），但底层余额确实被多扣了。未在本轮修复：正确的修复需要一个"模块已自行计量时平台不应重复计量"的选择退出机制，这是一个真实的设计决策，不是顺手能改的一行代码；如实记入 `docs/composite-tools.md`"已知简化"一节与本文档、`docs/cross-cutting-matrix.md` 的 recordCall 格。

测试：`test/direct-peer-channels/04-metering.js`——独立自建 server（同 03，因为需要非零 `--mcpToolCallCost` 才能让 `recordCall` 的效果可断言：0 成本下调用 N 次和调用 1 次在余额上无法区分），用 echo-device-client-module（无自身显式计量，断言无歧义）precisely 断言"一跳恰好收费一次"。连跑两次确认非 flaky：均 1/1 通过。

`docs/composite-tools.md` 更新："已知简化"一节新增两条：D5 对 `--directPeerChannels` 路径的改变（原"跨 worker 调用路径本身没有中心化计量"陈述现在只对 flag 关时成立），以及上述重复计费发现。

**已按用户要求同步更新 `docs/cross-cutting-matrix.md`**：`--directPeerChannels` 行的 recordCall 格填为"✅ 自动（D5）"，记录机制与测试指针，并把重复计费发现原样记入（含"未修复，留作后续设计决策"的说明）。

## Step 5（flag + 全量测试双态验证）：✅ 完成，commit `d759435`

flag 本身（`--directPeerChannels`，默认关）Step 1 已加好；`test8.js`（flag 开状态下复用 `test1.js` 全部既有断言 + 新增 4 个 direct-peer-channels 测试）Step 1-4 也已陆续建好但故意未接入 `package.json`（按施工图顺序留到本 Step）。本 Step 做的：

1. `package.json` 的 `test` 脚本正式接入 `test8.js`（排在 `test5.js` 之后、`test6.js`/`test7.js` 性能基准之前，与"功能测试→性能基准"的既有分组一致）。
2. 跑一次完整链路（`test1`→`test2`→`test3`→`test4`→`test5`→`test8`→`test6`，`test7.js` 按既有约定的开发环路惯例跳过，只在需要出具最终基准数字时单独跑）作为"flag 开/关两态下均绿"的正式确认。过程中一次因为自己的操作失误（并发跑了 `test/direct-peer-channels/03-grant-time-auth.js`/`04-metering.js` 两个独立起服务器的 standalone 测试，和 `test1.js` 抢占 9527 端口）撞坏了当次全链路运行——完整记录下来是因为这正是"为什么 03/04 要被排除在 `test8.js` 扫描之外"那条 Step 4 教训的另一次真实重演，只是这次撞的是我自己手动并发调度的锅，不是代码问题；确认干净重跑后不受影响。

结果（全部干净顺序执行，无并发干扰）：`test1.js` 34/34、`test2.js` 34/34、`test3.js` 2/2、`test4.js` 2/2、`test5.js` 1/1、`test8.js` 37/37、`test6.js` 2/2（耗时 5 分钟，纯粹是基准测试本身慢，非卡死）。`test/direct-peer-channels/03-grant-time-auth.js`、`04-metering.js`（standalone-only，不在链路里）顺序单独跑各 1/1。

## Step 6（benchmark + 英文 `docs/direct-peer-channels.md`）：✅ 完成，commit `2665d58`

新增两个 benchmark 脚本 + 两个纯粹为跑分而建的最小 fixture 模块（`pre-installed-packages/perf-caller-demo`/`perf-callee-demo`，非 demo/教学用途，仅供 `perf/direct-peer-channels-perf.js` 使用）。

1. **主对比基准**（`perf/direct-peer-channels-perf.js`）：主线程路由 vs 直连，3 档 payload（1KB/100KB/1MB）× 3 档并发（1/16/64），每格 150 次请求，跑在真实 worker_threads + 真实 HTTP 请求上（非模拟）。首次拿到 fixture 模块的 deviceID 冒烟测试时也踩了一次 D5 investigate 时同样的坑（`--debugKey` 与 fixture 内置 appKey 不匹配），复用已知解法（不设 `--debugKey`）绕过。

   **结果如实记录，不是"直连总是更快"的单一结论**：除了 1MB payload + 64 并发这一格，直连在所有其它 8 格上 p50 延迟都更低（常见 ~~2–13~~ 倍——**此数字系当时手算估计，2026-08-09 复核发现与表格不符，已修正**，见下），吞吐量也大多持平或更高。1MB+64 并发这一格出现反转（直连 p50 842ms，主线程路由反而是 360ms）——根因已定位且如实写进 `docs/direct-peer-channels.md`：两条路径最终都要经过同一对 worker（一个 caller 一个 callee），主线程路由路径里主线程本身虽是瓶颈，但也顺带起到背压/节流作用；直连路径没有背压机制，64 个并发 1MB 请求会在被调方 worker 的单线程事件循环里直接排队，排队曲线比被主线程"限流"过的路径更差。这是一个真实、尚未解决的局限（直连路径没有队列深度/并发上限），已如实记入文档，未在本轮修复（超出本 Sprint 范围，标注为后续任务）。**背压局限已在后续 commit `ff512d6` 修复，见下方"修复背压局限"记录。**

2. **D2 序列化子基准**（`perf/peer-channel-serialization-perf.js`）：在裸 `worker_threads.MessageChannel` 上对比 (a) `JSON.stringify`、(b) 裸对象 structured clone、(c) `Buffer`/`ArrayBuffer` transferList 零拷贝转移，3 档 payload，每格 300 次往返。**结论清晰且一致**：structured clone 在全部三档都胜出（~~比 stringify 快 2.7–3.7 倍~~——**此数字同样系手算，忽略了 1KB 档实际只有约 1.1 倍的提升，2026-08-09 已修正，见下**，比 transferList 更快）——与 `worker-message.js` 里那条引用 2016 年博客（当年结论是 stringify 更快）的旧注释相反，印证了"旧结论必须在当前 Node 版本上重新验证"这条项目自身规则。**决策：`lib/peer-channel.js` 维持现状（裸对象 postMessage），本身就是 D1 设计时已经采用的方案，数据只是确认而非要求改动**——未产生任何代码改动。

   **2026-08-09 修正记录**：以上两条比较性表述（"2–13 倍"、"2.7–3.7 倍"）都是手算/估算，与实际表格数据核对后发现不准确——不是回归或造假，是"写文档时口算而非用脚本算"这个习惯本身的问题。修复方式不是"重新手算一遍改数字"（同样的错误可能再犯），而是让两个 benchmark 脚本自己算出比较摘要句并打印出来，文档正文之后只允许原样复制脚本输出，不再允许任何手写的比较性表述。详见下方"修复发布阻断问题"记录与 `docs/direct-peer-channels.md` 最新版本。

`docs/direct-peer-channels.md`（英文）落地两张结果表 + 上述分析，并明确一句："这是本项目今后唯一可以引用的跨 worker 调用性能数字来源"，对应 CLAUDE.md"旧 20-30x 数字禁止引用"的要求。

至此 `docs/direct-peer-channels-design.md` 六步全部完成，D1–D5 五项设计决策均未偏离。

---

## 后续任务：修复背压局限（2026-08-09，用户要求）

Step 6 记录的"直连路径无背压/并发上限"这一局限已修复，commit `ff512d6`。

**修复过程**：第一版修复只限制了被调方（callee）`onInvoke` 的并发派发数，重跑 1MB+64 并发这一格实测**完全没有改善**（各档 cap 下 p50 都停在 608–685ms，与不设上限时几乎一样）——定位到根因：`postMessage` 对大 payload 的 structured-clone 开销发生在**发送时**，调用方（caller）的 `invoke()` 从未受限，64 个并发调用照样在发送端把 clone 开销全部付掉，被调方的派发上限根本来不及起作用。改为**双端**都限流（`lib/peer-channel.js` 的 `invoke()`——caller 发送方向——和 `onInvoke` 派发——callee 接收方向——都在超过上限时排队，容量释放后排到下一个）后，同一格重测：uncapped 688ms → cap=16 时 464ms，约 1.5 倍改善；用这组数据把 4/8/16/32 四档跑了一遍横向对比后选定默认值 16（4/8/16 效果相近，32 已经开始退化回接近 uncapped；选 16 而非更低的 4，是为了不在 1KB/100KB 这类原本无并发问题的场景里过度串行化）。

用 cap=16 重跑完整 9 格矩阵（同一次运行内两个条件都跑，避免跨次运行的系统噪音干扰对比）：**直连在全部 9 格 p50 都优于主线程路由**，包括之前反转的 1MB+64 一格（直连 417ms vs 主线程路由 608ms，注意这次两个条件的绝对数字都比 Step 6 原始数据高——同一格在不同次运行里波动明显，跨次运行的绝对数字不可比，只有同一次运行内的相对对比才可信，已如实写进文档）。

新增 CLI flag `--directPeerChannelsMaxConcurrency`（默认 16）。测试：`test/direct-peer-channels/05-backpressure.js`——不测性能（那是 perf/ 脚本的事），只测正确性：cap=2 时打 20 个并发调用，全部必须正确完成、无丢失。standalone-only（需要专属的低 cap 配置），已加入 `test8.js` 的排除列表。连跑两次确认非 flaky。全量测试（`test1`/`test2` flag 关、`test8` flag 开、`03`/`04` standalone）复跑确认无回归。

`docs/direct-peer-channels.md` 更新：主对比表换成 cap=16 下的新数据，新增"Backpressure"一节记录根因、双端限流的修复过程、cap 调参数据表、默认值选择理由，以及诚实标注的残留局限（固定调用数上限而非按 payload 大小/自适应，仍是可以做得更好的方向，未在本轮实现）。

---

## 发布阻断修复 1：性能数字一致性（2026-08-09，用户要求）：✅ 完成，commit `ab835d1`

用户复核发现 `docs/direct-peer-channels.md` 正文与最终 benchmark 表格的比较性表述不一致（"1.3–7×"实际应为 1.15–9.57×、"7 of 9"吞吐胜出实际是 5/9、"2.7–3.7×"忽略了 1KB 档只有约 1.1 倍这一事实）——根因是这些句子是**手算**的，会话过程中数据经历了多次重新 benchmark（先是初版、又是 backpressure 修复后重跑），文档正文没有跟着每次重算同步更新，出现漂移。

**修复不是"重新手算一遍改数字"**（同一失误模式还会再发生），而是把比较摘要的计算权交给脚本本身：

1. `perf/direct-peer-channels-perf.js` 新增 `buildReport()`：跑完 9 格矩阵后自动算出并打印——p50 提升范围（含最小/最大值所在的具体格）、吞吐胜出格数明细（哪几格直连赢/哪几格主线程路由赢）、p99 互有胜负的格子明细（含具体数字）。`perf/peer-channel-serialization-perf.js` 同样新增 `buildReport()`，算出三种序列化策略在每档 payload 下的胜者与比值范围。两个脚本都打印 markdown 表格 + 摘要句到 stdout，可直接复制进文档。
2. 两个脚本各重新跑一遍全新数据（会话过程中系统噪音明显，新数据与旧数据不完全相同——这符合已经写进文档的"跨次运行数字会波动，只信任同次运行内的相对对比"这条原则）。
3. `docs/direct-peer-channels.md` 的两张 benchmark 表格与所有比较句改为原样粘贴脚本这次运行的输出，正文加一句"这里的每个数字和每句比较性表述都是从脚本某一次运行原样复制的"，并保留一句明确说明旧的错误表述是什么、错在哪。
4. 施工图里旧的"2–13 倍"、"2.7–3.7 倍"两处改为删除线 + 修正说明（不是静默改掉，保留错误发生过的痕迹）。
5. 全文 grep 确认：仓库内除了"引用旧错误表述作为反面教材"的几处（`docs/direct-peer-channels.md` 与两个 perf 脚本的注释里，明确用引号标出"曾经错误地写过 X"）之外，没有残留的旧数字。

全量测试（`test1`/`test2` flag 关、`test8` flag 开）复跑确认 perf 脚本改动不影响任何测试路径（perf/ 下的文件不参与 `npm test`）。

---

## 发布阻断修复 2：双重计费修复（2026-08-09，用户要求）：✅ 完成

`docs/composite-tools.md`"已知简化"记录过的已知问题——`--directPeerChannels` 开启时，`composite-demo` 每跳被扣两次费（自己显式调用 `CHUtil.recordCall` 一次，D5 的平台自动计量又扣一次，2 跳应扣 2 实际扣 3）——本轮改为正式修复，而不是继续留作已知缺口。

**设计原则（用户明确要求）**：平台自动计量是跨 worker 调用**唯一**权威计费源，直接影响余额；模块自己的显式计量调用与平台计费彻底分离，永远不再扣余额。

**架构改动**：
1. D5 的平台自动计量从只覆盖 `--directPeerChannels` 路径，扩展到覆盖**两条路径**——`DeviceManager.prototype.sendInvokeActionMessageToWorker`（主线程路由，flag 关的默认路径）现在也会在回复调用方之前自动调用 `CHUtil.ci.recordCall`。这样"平台计量是唯一计费源"在两种 flag 状态下都成立，不需要靠"某条路径没有平台计量所以模块必须自己计量"这种依赖关系。
2. `--directPeerChannels` 路径的计量从**fire-and-forget**（`sendPeerMeteringToParent`，不等回复）改为**同步 request/reply**（`sendPeerMeteringRequestToParent`/`sendPeerMeteringReplyToChild`，新增 `peer-metering-request`/`peer-metering-reply` wire 消息，`lib/worker-message.js`/`lib/sandbox.js`/`lib/peer-channel-broker.js`）——被调方 worker 要等计费结果落地后才回复调用方，这样计费结果才能真正带回给调用方模块。
3. 模块面向的 `CHUtil.recordCall`（`lib/countinghouse-util.js`）整体移除，替换为 `CHUtil.recordUsage`——纯应用层记账，完全不接触 `MeteringProvider`/余额。平台内部代码（`lib/peer-channel-broker.js`、`lib/device-manager.js`）改为直接调用 `CHUtil.ci.recordCall`（原始的、真正扣余额的接口），绕开模块层封装。`composite-demo` 改为调用 `CHUtil.recordUsage` 做自己的审计记录（不影响 `bill` 里的 `charged`/`balance` 数字），`bill` 改为读取平台计量结果。

**实现中发现并修复的第二个问题（真正的坑）**：第一版实现把平台计量结果合并进 `ServiceClient.invoke()` 回调的 `data` 参数里（`Object.assign({}, data, {_platformMetering: ...})`），手测 `test/direct-peer-channels/04-metering.js` 时发现请求稳定卡满 30 秒后才以 `DEVICE_NOT_RESPONDING` 失败——排查（加时间戳日志逐段定位）发现整条计量 request/reply 链路本身只花了 20 毫秒左右就完整走完，30 秒来自**下游**：`echo-device-client-module` 的动作把收到的 `data` 原样透传为自己的返回值，而 `lib/service.js` 的 `Service.prototype.validateActionCall` 会遍历返回值的**每个 key** 去查 `action.argumentList[i].relatedStateVariable`，`_platformMetering` 这个多出来的 key 在 schema 里没有对应项，直接抛 `TypeError: Cannot read properties of undefined`——这个异常发生在跨 worker 消息回调链路上，`lib/service.js` 现有的 Domain 异常捕获没接住，于是那次回调静默丢失，只剩外层 Session 的 30 秒超时兜底触发。

**修复**：不再把计量结果合并进 `data`，改为作为**第三个、附加的回调参数**独立传递——`function(err, data, platformMetering)`，从 `PeerChannel`/`WorkerMessage`/`Session.prototype.callback`/`sandbox.js` 的 `invoke-action-reply` 分支，一路原样透传到 `ServiceClient.invoke()` 的回调，全程不碰 `data` 本身。`composite-demo` 相应地从读 `data._platformMetering` 改为直接用回调的第三个参数。

**测试**：新增 `test/direct-peer-channels/06-no-double-billing.js`，两个 `describe` 块分别覆盖 `--directPeerChannels` 开/关两态：加载 `composite-demo` + `transform-demo` + `echo-device-module`，断言 2 跳复合调用余额**恰好**扣 2（不是 3），`bill` 仍显示 2 条独立记录，两态均通过。`04-metering.js` 的旧注释（提到"fire-and-forget"、"comp-demo 双计费未修复"）同步更新为符合新架构的说法，并去掉了不再需要的 500ms 结算延迟等待（现在是同步 reply，`invoke()` 回调触发时计费已经落地）。

全量测试复跑确认无回归：`test1`–`test6`（flag 关默认路径）、`test8`（flag 开，含 `direct-peer-channels/01`、`02`）、standalone-only 的 `03`/`04`/`05`/`06` 全部通过。

**文档同步**：`docs/composite-tools.md`"计量"一节改写为描述新架构（平台计量唯一权威、`platformMetering` 第三参数、`recordUsage` 纯记账），"已知简化"里的双计费条目从"已知问题，未修复"改为"已修复"并说明原则；`docs/cross-cutting-matrix.md` 两条 "Direct peer channel" 行的 `recordCall` 列同步更新（主线程路由行从"❌ not automatic"改为"✅ automatic"，`--directPeerChannels` 行的"Caveat found during verification, not fixed"改为"Fixed"）。

### 补记：无法解析身份的内部调用，计费行为已明确记录（2026-08-09，用户要求）

用户提问：默认路径现在自动计量后，不带 apiKey 上下文的老式跨模块调用（`CHUtil.createServiceClient` 的 `ctx` 兜底路径——传入一个 `appKey` 本身就是 `null`/`undefined` 的 session，这条路径真实存在但当前所有内置示例模块都用固定 `appKey`，从未被实际触发过）计费落在哪个身份上，还是静默跳过——行为本身怎样都行，但 `cross-cutting-matrix.md` 必须有明确一格，不能留空。

**验证方式**：没有停留在读代码推断，搭了一个临时 scratch 模块（复制 `echo-device-client-module`，把其中一个 `createServiceClient` 调用改成 `{deviceID, serviceID, ctx: {}}`——`ctx` 非空但没有 `appKey` 字段，制造出一个真实可达的、appKey 解析为 `undefined` 的 `ServiceClient`），起真实 server，`--mcpToolCallCost 1`，两种 flag 状态各测一遍，实测观察行为而非假设。

**确认的行为**（两条路径一致）：调用本身**成功完成**（不报错、不挂起）；`RedisMeteringProvider.prototype.recordCall`/`checkBalance` 自带的 `apiKey == null` 防护触发，报 `"apiKey is required"`，被 `LOG.E` 记到服务端日志；调用方收到的 `platformMetering`（回调第三参数）为 `null`；**没有任何 apiKey 的余额被扣**，包括字面量 `"undefined"` 这个 key 也确认未被误写。净效果：一个身份无法解析的内部调用会被**无限期免费放行**，没有任何对调用方可见的信号——这是一个真实但范围很窄的计费漏洞（不是崩溃或挂起），未在本轮修复（用户明确说行为本身怎样都行），只是此前完全没有文档记录。

**文档落地**：`docs/cross-cutting-matrix.md` 两条 "Direct peer channel" 行的 `recordCall` 格各自追加一段，逐字记录上述验证方法与结论（含具体调用链：主线程路由行——`sendInvokeActionMessageToWorker` 捕获 `recordCall` 的错误、记日志、仍然回复调用方；`--directPeerChannels` 行——`handleMeteringRequest` 未额外校验 `data.callerModule`，同样的错误路径经 `peer-metering-reply` 传回，`onPeerChannelOpen` 的 `onInvoke` 同样捕获、记日志、仍然回复）。`docs/composite-tools.md`"已知简化"里"外层调用方 apiKey 未穿透"那条追加说明：`ctx` 兜底机制已经存在，但如果将来真的接上它，需要事先明确决定"身份解析失败时到底应该拒绝调用、退回某个兜底身份、还是维持现状静默跳过"，而不是继续沿用今天这个从未被真正决定过、只是"guard 恰好这么写"的默认行为。

---

## AuthProvider 重构：退役 legacy 计价死代码（2026-08-09，用户确认方案后执行）

`lib/service.js` 的 `realPrice`/`NOT_ENOUGH_USER_BALANCE` 门禁与 `lib/session.js` 的 `Session.prototype.updateRedisUserRecord` 已删除——这是老式"CouchDB `devices[].priceRecord` 免费调用配额 + per-action `realPrice` 余额门禁"计价系统的核心，`userAuth` 现状勘察报告（见上文"userAuth 现状勘察报告"相关记录）已确认：全部内置示例模块从未声明过 `realPrice`，这条门禁在整个测试矩阵里从未真正触发过，是纯粹的死代码。随之清理 `Session` 构造函数里同样再无读取方的 `realPrice`/`userDevices`/`apiRemainCount` 字段赋值（`balance` 字段保留——足够通用、成本为零，未来 MeteringProvider 若要在 Session 上暴露余额可以直接复用）。

**`priceRecord`（免费调用配额）概念本身未被删除，记入 roadmap**：`lib/metering/redis-provider.js` 的 `recordCall` 仍保留读取 legacy `devices[].priceRecord[serviceID][actionName]` 的 fallback 分支（未删代码，只更新了头部注释说明现状）——AuthProvider 重构后已没有任何代码再往 Redis 的 `devices` 字段写入数据，这段 fallback 逻辑现在**可达性为零**，但背后"预付费按工具配额"这个计价模型本身是真实、有价值的概念，不属于 AuthProvider 的职责范围（AuthProvider 只回答"能不能访问"，不管"还能免费用多少次"）。作为后续任务记录：如果要重新实现预付费配额，应该做成 `MeteringProvider` 的一个新方法/新 provider 实现，而不是复活这段绑定在旧 CouchDB schema 上的 fallback 代码。

测试：`test1.js`（34/34）、`test8.js`（37/37）复跑确认无回归——两者都在 `--debug` 模式下运行，从未真正触发过这条被删除的门禁，这也是"从未被测试覆盖过"这一判断的又一次直接印证。

---

## AuthProvider 重构：完整状态记录（2026-08-09，用户确认方案后执行，全部完成）

按用户确认的 10 步方案逐一执行，每步单独 commit。汇总记录（第 4 步"退役 legacy 计价死代码"已单独记录在上一节，此处不重复）：

**第 1 步（`f811cc0`）—— AuthProvider 接口 + 7 个调用点改走 authenticate + tools/list 过滤**：`lib/auth/provider.js` 定义接口——`authenticate(apiKey, deviceID, serviceID, actionName, cb) → {ok, userName, err}` + `listDevices(apiKey, cb) → {devices:[...]}`，刻意比原 `doUserAuth` 窄：`balance`/`apiRemainCount`/`priceRecord` 不属于 AuthProvider 职责（归 MeteringProvider）。`lib/user-auth.js` 的非 debug 分支改为委托给配置好的 provider，`--debug` 分支与函数签名完全不变，因此 7 个调用点（`routes/user.js`、`mcp/gateway.js` ×2、`mcp/tool-registry.js`、`device-manager.js`、`service-client.js`、`peer-channel-broker.js`）**零代码改动**。`lib/routes/device-list.js` 改用 `listDevices`。核实确认 MCP `tools/list` 此前**从不**按 apiKey 过滤（每次都列出全部已加载设备的 tools，只是对无权限设备的 schema 解析退化为默认值，从不省略该 tool）——补上 `filterTargetsByAuth`，`--debug` 模式下跳过（维持既有"debug 模式不做设备级鉴权"模型）。过程中发现并修复一个此前从未被测试覆盖的真实 bug：`routes/user.js` 的 `validateUser` 中间件的鉴权失败响应从未包含 `err.code`/`err.topic`（硬编码 `topic: 'countinghouse error'`），因为此前没有任何测试真正触发过这条失败分支（全仓库测试都在 `--debug` 模式下跑，`userAuth` 从不在那里报错）。测试：`test/auth/01-file-provider-tools-list-filtering.js`（首个不用 `--debug` 起服务器的测试）。

**第 2 步（`8fff1c3`）—— FileAuthProvider 零配置体验**：无 `auth.json` 时自动生成一个带通配符（`devices: ["*"]`）访问权限的 demo key，写入文件（保证重启后仍有效，不会每次重启就失效）并打印一次；已存在的（哪怕是空的）`auth.json` 不会被覆盖。`COUNTINGHOUSE_API_KEY` 环境变量提供独立于文件之外的单 key 通配符模式，两者可同时生效。测试：`test/auth/02-file-provider-unit.js`（首个不需要服务器的纯单元测试）。

**第 3 步（`72cab76`）—— SqliteAuthProvider**：复用已有 `sqlite3` 依赖，`users`(apiKey, userName) + `user_devices`(apiKey, deviceID) 两表，`deviceID='*'` 同样表示通配符（与 FileAuthProvider 保持一致的约定）。运行时增删走 `bin/countinghouse-auth-sqlite.js` 这个最小 CLI（`add-user`/`remove-user`/`grant`/`revoke`/`list`），不做 HTTP 管理端点——管理"谁能鉴权"的端点本身还需要鉴权，属于不必要的循环复杂度。测试：`test/auth/03-sqlite-provider-unit.js` + 手工对真实服务器的端到端验证。

**第 5 步（`069bd5a` + `f25df72`，因 `git add` pathspec 报错被拆成两个 commit 才完整落地）—— 彻底删除 proxy-handler/api-proxy**：`lib/proxy-handler.js`（CouchDB `api-proxy-device` 库驱动的反向代理主机映射）、`--reverseProxy` CLI flag 及其在 `route-manager.js`/`monitor.js` 里的全部接线、`lib/routes/reverse-proxy.js`（一个从未被真正 `require` 过的孤儿文件，硬编码 IP，依赖一个连 `package.json` 里都没声明过的包）全部删除。全仓库无测试覆盖过这个功能。`express-http-proxy` 从依赖里移除。

**第 6 步（`9b3c18f`）—— device-config 改文件后端**：`lib/device-config.js` 改为从 `--deviceConfigPath`（默认 `./config/devices`）读取 `<moduleName>.json`，不再查 CouchDB `device-config` 库的 `byModuleName` 视图。保持完全相同的 `global.DeviceConfig` 契约与单线程/多线程模式下的合并 vs. 替换语义。**不是数据迁移**：这个仓库本来就从没有过写入那个 CouchDB 库的代码路径，没有真实数据需要迁移。测试：`test/device-config/01-file-backend-unit.js`（文件存在/不存在/目录不存在/JSON 损坏四种情形）。

**第 7 步（`ea33f8f`）—— 删除 c9-launcher/vscode-launcher**：两个文件都是已停用的 apemesh 商业平台"模块在线 IDE 编辑"功能（Cloud9 / code-server 集成），`--cloud9`/`--vscode` flag 及 `module-manager.js` 里模块上传安装流程中所有相关分支（含仅在 vscode 模式下才有意义的"跳过 npm install，从持久化位置加载"这条死路径）一并删除。`respawn`/`isbinaryfile`/`chokidar` 三个只被这两个文件使用的依赖从 `package.json` 移除。

**第 8 步（`2d75755`）—— CouchDBAuthProvider + nano 移出主依赖**：`lib/couchdb-adapter/couchdb-auth-provider.js` 包装原 CouchDB 鉴权逻辑，作为第三个可选 provider（`--authProvider couchdb`）。同目录下 `init-db.js` 是一个从零重写的建库 + design doc 初始化脚本——严格按"输入 apiKey，输出 `[userName, balance, devices]`"这条查询契约重新实现 map 函数，本仓库从未有过原始 design doc 的真实内容或任何写入 CouchDB 的代码路径，所以这不是"移植"，是照契约重新实现。`nano` 从 `dependencies` 移除，两个文件内部改为惰性 `require('nano')`，缺失时抛出带明确安装命令的错误（已验证：不装 nano 时构造 `CouchDBAuthProvider` 会抛出这条错误信息；换用其他任意 provider 或默认启动路径完全不受影响）。测试：`test/auth/04-couchdb-provider.js`——这台开发机既没装 nano 也没有可达的 CouchDB，测试会优雅跳过（mocha pending，非失败）而不是报错。

**第 9 步（`ca697b3`）—— 接入默认测试矩阵**：`test/auth/*.js` 与 `test/device-config/*.js` 此前只能手工 `npx mocha` 单独跑，接入 `package.json` 的 `test` 脚本与 `.github/workflows/ci.yml`（排在 `test5` 之后、`test8`/`test6` 之前）。至此非 debug 鉴权路径（含 `USER_HAS_NO_DEVICE`、`tools/list` 过滤）第一次拥有了持续、自动跑的测试覆盖，而不再依赖手工验证；`--debug` 下的既有测试套件完全不变。

**测试期间的插曲，记录以备将来复核**：验证过程中反复撞到与本次改动无关的环境噪音——(1) 本机上跑着另一个 PM2 托管的、完全独立的旧版本部署（`/home/mchen6/cdif.code/build/cdif`），与本仓库的测试共用同一个 Redis 实例；(2) `test1.js`/`test8.js` 固定 5 秒的服务器启动等待时间，在这台机器上经常不够（实测"all module discovered"经常要 7-12+ 秒）。用 `git stash` 把本次改动完全移除、在同一台机器上跑同一个 baseline 测试，复现了同样的失败模式——**确认这些失败与本次 AuthProvider 改动无关，是这台机器长期存在的环境问题**，经用户确认后按"忽略、按需重跑"处理，不在本次范围内修复。每一步的实际正确性验证改为以更快、更可靠的方式为主：新增的单元测试（不依赖服务器启动时序）+ 针对性的手工端到端验证（给足等待时间，规避已知的环境计时噪音）。

**收尾**：按用户指示，完成以上全部后执行 README 重写，鉴权部分改为描述"pluggable（file/sqlite/couchdb-adapter）"，quickstart 以"零外部依赖"为基线（不再要求先起 CouchDB）。

---

## CI 修复：Domain 模块异常捕获替换为 try/catch（2026-08-09）

AuthProvider 10 步方案推送后，GitHub Actions CI（`.github/workflows/ci.yml`，Node 20/22 双矩阵）双双失败：`test1.js` 跑到 `test027`–`test030` 时抛 `TypeError: Cannot read properties of undefined (reading 'startsWith')`，"Run functional tests" 整步中止，`test2`–`test5`/新鉴权测试/`test6` 均未执行。

**排查过程（本环境无 `gh` CLI、无 `GITHUB_TOKEN`，日志靠用户粘贴获得，本机本地复现被证实不可信——见下）**：

1. **初始假设**（基于既有记忆 `project_domain_module_fragility` 记录的 Sprint 2 nano 升级事故）：`lib/service.js` 的 `Service.prototype.doActionCall` 用 Node 已废弃的 `domain` 模块做异常隔离，怀疑是又一次 domain 对依赖树变化的脆弱性发作。用户明确选择"根治方案"：把 domain 替换为 `try/catch`，而非绕开症状的局部方案（如重新引入已删除的 `nano` 依赖）。
2. **第一版 try/catch 替换后，实测复现出**同样的症状（`fault` 序列化成 `{}`）——说明假设不完整。用一次干净的 A/B 对照定位真因：把 `lib/service.js` 换回 commit `79132eb` 的原始 domain 版本，用**同一份** `node_modules`、同一台机器直接起服务器实测，**结果完全相同**——证明这个"捕获的异常序列化成 `{}`"的 bug 在 domain 时代就已经存在，从来不是 domain 在防护的东西。根因：原生 `Error` 对象的 `.message`/`.stack` 是不可枚举属性，`res.json({fault: err})` 必然序列化成 `{}`，与捕获机制（domain 还是 try/catch）无关。
3. **本地复现环境本身不可信，此次排查中正式确认**：全新 `git clone` + `npm install` 在本机会撞上与 CI 无关的 `sqlite3`/glibc 版本不匹配（本机 glibc 2.35 < 预编译二进制要求的 2.38，CI 的 `ubuntu-latest` glibc 更新，不受影响）；直接 `npx mocha test1.js` 重跑多次会出现与 CI 实际失败不一致、彼此也不一致的失败特征（ECONNREFUSED、时序竞态等）。结论：本次排查改为完全以用户粘贴的 CI 日志为唯一权威事实来源，不再信任本地全量跑分作为 CI 信号的替代。

**修复**（原 commit `b9ac21e`，2026-08-10 历史重写后为 `1184029`）：
1. 新增 `toJSONSafeFault(err)` 辅助函数，把捕获到的 `Error` 显式转成 `{message, name, stack}` 纯对象再作为 `fault`/`data` 传给回调，从根本上修掉序列化缺口，与捕获机制无关。
2. `Service.prototype.doActionCall` 的 `Domain.create()`/`unsafeDomain.run()` 包装替换为 async 分支的 `try { await action.invoke(args) } catch`、callback 分支的 `try { action.invoke(...) } catch`。
3. **诚实记录的能力损失**（写进 `lib/service.js` 代码注释）：`try/catch`（含 `await`）只能捕获与自身**同步相对位置**抛出的异常，无法捕获在完全脱离调用栈的回调（如一个从不调用自身回调的裸 `setTimeout`）里抛出的异常——这正是 domain 模块当年存在的意义，且没有非废弃的现代等价物（除非引入更大范围的 `AsyncLocalStorage` 重实现，本次不在范围内）。`test/unit/test029.js`（`testAsyncThrowInDomain`）与 `test030.js`（`testAsyncThrowInAsync`）的测试动作就是刻意在裸 `setTimeout` 里抛异常来验证这个场景，两个文件相应更新为断言"请求超时后收到 `DEVICE_NOT_RESPONDING`"而非"快速收到结构化的 `DEVICE_INVOKE_EXCEPTION`"——这是一次有意的、已记录的行为变化，不是回归。

**验证**：
- 手工起服务器 + `curl` 直接验证 `testThrowError`/`testThrowErrorAsync`（同步抛异常）：`fault.message`/`name`/`stack` 均正确填充，不再是 `{}`。
- 用 `--requestTimeout 3` 起服务器验证 `testAsyncThrowInDomain`/`testAsyncThrowInAsync`（裸 `setTimeout` 内抛异常）：均在约 3 秒（即配置的 timeout）后返回 `DEVICE_NOT_RESPONDING`，行为与代码注释描述一致。
- 完整回归：`test1.js`（34/34，含更新后的 test029/030）、`test2`–`test5`、`test/auth/*.js` + `test/device-config/*.js`、`test8.js`（单/多线程、`--directPeerChannels` 各态）全部通过，`test6.js`（基准测试）顺带跑过也全绿；`test7.js`（另一档基准）按惯例跳过。
- 推送后经 GitHub `check-runs` API（无 `gh` CLI，用未认证 REST API 轮询）确认：`test (20)`、`test (22)` 均 `completed`/`success`。CI 转绿，是本轮排查的最终目标。

**收尾**：把此前一直只在本地工作副本、从未提交的 `CLAUDE.md`、本文档、`docs/direct-peer-channels-design.md` 一并提交推送（原 commit `faca05a`，2026-08-10 历史重写后为 `dbb3196`），仓库状态与本地完全同步。

---

## 当前状态快照（2026-08-10，供后续会话/其他 Claude 参考）

**已完成、无需重复核实**：Sprint 1–5 全部任务；Direct Peer Channels 设计文档六步全部实现（D1–D5 五项决策均未偏离）；两次发布阻断修复（性能数字一致性、直连路径双重计费）；AuthProvider 10 步重构 + legacy 计价死代码退役；本节记录的 CI 修复（domain → try/catch + `toJSONSafeFault`）。CI 在 Node 20/22 均绿（原 commit `b9ac21e`）。仓库与 `origin/master` 完全同步（原最新 `faca05a`，见下方 P0-4 收尾一节——此后发生过一次历史重写，全部历史 hash 已变化）。

**明确剩余、尚未开始**（原施工图"七、内容与发布"，只有 七.1 README 完成）：
- 七.2 技术博客初稿（《We built MCP's tool architecture in 2015 — by accident》）
- 七.3 Show HN 发帖 + 首日答疑口径
- 七.4 注册官方 MCP Registry（`server.json` 已就绪）+ 提交 awesome-mcp-servers/awesome-mcp-gateways 收录 PR

**已如实记录为已知问题/roadmap，非阻断，暂无计划修复**（见各自小节）：`lib/socket-server.js` 事件推送链路本身不完整（只修了参数错位）；身份无法解析的内部调用会被无限期免费放行；direct peer channel 的并发上限是固定值（16），非按 payload 大小自适应；`priceRecord` 预付费配额概念未重新实现（如需要应作为新 `MeteringProvider` 方法，而非复活绑定旧 CouchDB schema 的 fallback 代码）。

---

## P0-4 收尾：git 历史凭证清理（2026-08-10）✅ 已关闭

> **重要**：`git filter-repo` 会重写从最早一次改动开始的每一个后续 commit 的 hash（父 hash 变了，自身 hash 就变），而本轮清理触及的最早一个泄露文件在 2015 年代的原始历史中就存在——意味着**本文档在此之前记录的几乎全部 commit hash 引用都已过期**，在当前 `origin/master`/本地仓库上已找不到那些具体的 hash。这些引用作为"这件事发生过、这是当时的提交信息"的历史记录仍然准确，只是不能再用于 `git show <hash>` 之类的操作；如需定位某次改动，改用 commit message 关键词搜索（`git log --all --grep=...`）。以下本节的新 hash 引用均为重写后的当前值。

`aad25fa`（2026-08-07）当时明确把"HEAD 内容原地脱敏"与"`git filter-repo` 历史重写"标注为两个独立、故意分开的后续动作，只做了前者。本轮核实发现历史重写这一步此前从未执行——直接查证 `origin/master`（真实公开的 `mchen6/countinghouse` 仓库，而非本地假设）确认 681 个 commit 的完整历史（含改名前 2015 年起的原始仓库历史）已经推送公开，其中包含泄露凭证的原始提交仍可被任何人 `git clone`/`git log -p` 读到。线上 token 本身早已吊销（2026-08-08），但历史暴露本身此前从未真正关闭。

**执行方式**（严格遵循施工图原定方法：先在一次性 fresh clone 上跑 `git filter-repo --replace-text`，验证干净后再 force-push 覆盖旧仓库，不在原地操作）：

1. 复用本地保存的 gitleaks 全历史扫描结果（`gitleaks-report.json`，2026-08-07 产出，46 处发现收敛为 11 个不同的真实 secret 值）构建 `--replace-text` 替换表。
2. **过程中发现一个必须排除的假阳性**：11 个值中的一个（`test/loop.sh` 里被 `curl-auth-header` 规则命中的字面量 `123456789`）根本不是凭证，只是脚本里的占位 header 值；第一次不排除直接跑替换，验证时发现它把 `test/unit/test002.js` 里一个无关的测试用 deviceID 片段也误伤替换掉了——排除该值后重跑，问题消失。最终替换表为 10 个真实 secret。
3. **过程中发现一个此前未被 `aad25fa`覆盖的、当前仍在 HEAD 里的真实遗留泄露**：`example/oauth-server/README` 里一组 2019 年本地 oauth2-server demo 产生的 authorizationCode/accessToken/refreshToken，gitleaks 之前的报告里其中两个已被记录（`accessToken`/`refreshToken`，规则 `generic-api-key`），`authorizationCode` 因字段名不在规则关键词列表里未被命中，但同属一类，一并处理。**先在原仓库单独提交推送**（原 commit `9130f38`，2026-08-10 历史重写后为 `2ea7d57`，正常 push，不涉及历史重写）做原地脱敏，与 `aad25fa` 手法一致。
4. 从推送后的最新 `origin/master`（含上一步）重新 fresh clone，跑 `git filter-repo --replace-text`（10 个真实 secret），验证：commit 数量不变（682）、`git log -p --all` 全历史重新扫描确认 10 个 secret 全部 0 处残留、HEAD 树内容与重写前逐文件 diff 完全一致（无意外改动）。
5. 确认干净后 `git push --force origin master`（旧 `origin` 已被 `filter-repo` 自动移除，重新 `git remote add` 后推送）。所有 commit hash 因此改变（这是 `filter-repo` 重写的必然结果，不是意外）。
6. 本地工作副本（此前一直指向旧 hash 历史）`git fetch` + `git reset --hard origin/master` 同步到新历史；额外执行 `git reflog expire --expire=now --all && git gc --prune=now --aggressive`，`git cat-file -t` 确认旧的、含明文凭证的 commit 对象已从本机 `.git` 对象库物理删除，不只是不可达。

**如实记录的残留边界，不过度宣称**：
- 本机本地仓库与 `origin/master` 上的可达历史均已确认干净；GitHub 服务端是否会保留一段时间内部缓存的悬空对象（dangling object，标准 git force-push 后的已知行为，通常最终会被 GitHub 自身的垃圾回收清理，但具体时间线不受本地操作控制），未做进一步核实——如需更强保证，可联系 GitHub Support 请求清理服务端缓存。
- 若在此次 force-push 之前有任何第三方已经 clone/fork 过旧仓库，那些副本仍完整保留旧历史（含泄露凭证），force-push 无法追溯清除；据此前记录，这个仓库改名后才公开发布不久，第三方 clone/fork 的可能性判断为低，但未做穷举核实。
- Sensoro 第三方凭证（随 `lingyi-fire-control-data-module` 一并出现在历史中）本轮随同其余 10 个值一起从历史中清除；轮换该凭证不是本方的权限范围，此前已如实记录为"仅标记未处理"，本轮的清除动作不改变这一结论——只是让它不再能从 git 历史里被读到。

**验收结果**：`origin/master` 与本地仓库均确认 10/10 目标 secret 在全历史 0 处残留；commit 树内容（除目标 secret 字符串外）逐文件比对与重写前一致；`git fsck --full` 干净。P0-4 至此视为完整关闭。

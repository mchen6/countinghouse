# CDIF 代码审计与改造施工图
> 审计对象：github.com/mchen6/cdif @ v3.1.2（commit fa527da）
> 目标定位：MCP 工具的多租户运行时 + 货币化/市场后端（新名称待定）
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


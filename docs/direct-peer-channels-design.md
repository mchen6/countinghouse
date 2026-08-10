# 设计文档：Worker 间直连 MessageChannel（消除跨 worker 调用的主线程双跳）

> 状态：设计定稿，待实现。实现归入 Sprint 5，作为「P2-复合工具 demo」的前置任务——复合工具的性能故事必须建立在直连路径上。
> 仓库内最终文档（docs/direct-peer-channels.md）与代码注释按 CLAUDE.md 约定用英文；本文件是给 Claude Code 的中文施工说明。

## 1. 现状与目标

**现状**（对照 v3.1.2 代码结构，文件名以 rename 后为准）：worker A 内的 serviceClient.invoke 调用 worker B 的 API 时，路径为 A → parentPort → 主线程 WorkerMessage（msgQueue 关联）→ B 的 worker.postMessage → B 执行 → 原路两跳返回。每次调用 4 次 postMessage、两次经过主线程事件循环，主线程成为所有跨模块调用的串行瓶颈。

**目标**：控制面留在主线程（brokering、鉴权、失效管理），数据面点对点——A 与 B 之间经 `MessageChannel` 端口对直接收发，每次调用 2 次 postMessage、零主线程参与。

## 2. 设计决策（五项，实现时不得偏离）

### D1 端口拓扑：惰性按对 brokering，不在创建时预铺
不要在 worker 创建时把"所有其他 worker 的 port"塞进 workerData——那是 O(N²) 预铺且无法处理后加载的模块。正确做法：
- A 首次 invoke 目标为 B 的设备时，经**现有** parentPort 通道向主线程发 `peer-channel-request {targetDeviceID}`。
- 主线程校验（见 D3）后 `new MessageChannel()`，`port1` 经 transferList 发给 A、`port2` 发给 B（`worker.postMessage({command:'peer-channel-grant', peerKey, port}, [port])`），双方注册 handler 并缓存。
- 缓存 key 用 `targetWorkerId`（不是 deviceID——同一 worker 可承载多设备，端口按 worker 对复用）。A 侧维护 `peerPorts: Map<workerId, PeerChannel>`；主线程维护 `channelRegistry: Map<"idA:idB", true>` 防重复建对。
- 竞态处理：A 在等待 grant 期间的后续调用进队列；B 收到 grant 是被动的，只注册 handler。

### D2 直连协议：复用 msgID 关联模式，新建 PeerChannel 类
每个端口对上的请求/响应关联复用 WorkerMessage 已验证的 msgID/msgQueue 模式，但独立实例（每个 PeerChannel 有自己的 id 空间）。消息形状：
```js
// request:  {id, command:'peer-invoke', deviceID, serviceID, actionName, input}
// response: {id, category:'peer-reply', errMsg, data}
```
超时：每个 pending 调用挂定时器（默认沿用现有 requestTimeout 配置），超时即回错误并清 msgQueue 槽位——直连路径没有主线程兜底，超时必须在调用方本地实现。

**序列化 benchmark 子任务**：worker-message.js 现有注释引用 2016 年博客选择了 stringify 全量消息。在 PeerChannel 上对比三种方案的 p50/p99（1KB / 100KB / 1MB payload）：(a) JSON.stringify 字符串，(b) 裸对象 structured clone，(c) 大 payload 走 ArrayBuffer transferList。按数据选默认，结论写进 docs。

### D3 安全模型：端口即能力（capability），鉴权前移到 brokering 时刻
现有跨模块调用在主线程路径上做 userAuth；直连后数据面不再经过主线程，**每调用鉴权改为每通道鉴权**：主线程在 grant 前校验"A 所属模块是否有权调用 B 的设备"（沿用现有 device-auth 逻辑，一次性），通过后端口本身就是持续有效的调用凭证。文档里明确这个模型转变：possession of the port = authorization。撤销手段见 D4（失效即撤销）。若未来需要按 action 细粒度控制，在 grant 消息里附 allowedActions 白名单，PeerChannel 在调用方本地先检——本期不实现，留接口注释。

### D4 生命周期：热重载/崩溃下的端口失效（本设计最关键的部分）
热重载是平台的招牌特性，端口失效处理不能马虎：
- 主线程在 reload-module / unload-module / worker `exit` 事件中，查 channelRegistry 找出所有涉及该 worker 的通道，向每个对端 worker 广播 `peer-invalidate {workerId}`。
- 对端收到后：关闭并删除缓存 port，msgQueue 里该通道所有 pending 调用立即回 `PEER_GONE` 错误（不等超时）。
- 双保险：PeerChannel 同时监听 port 的 `close` 事件（对端 worker 终止时自动触发），处理逻辑同上——避免依赖主线程广播的时序。
- 失效后的下一次 invoke 自然触发 D1 的重新 brokering，新 worker 实例拿到新端口。对调用方模块代码完全透明。
- 测试必须覆盖：调用进行中热重载目标模块 → 调用方收到明确错误且下一次调用成功走新实例。

### D5 计量保留：数据面绕过主线程,计量不能绕过
复合工具的分成链故事依赖内部调用可计量（见施工图 P2-复合工具第 2 条），直连不得造成计量盲区：
- 被调方（B）的 PeerChannel handler 在每次执行后，向主线程发**fire-and-forget** 的 `peer-metering {callerModule, deviceID, serviceID, actionName, ts, durationMs, ok}`（经现有 parentPort，无需回执）。
- 攒批可选：先逐条发实现正确性，若 benchmark 显示计量消息成为新瓶颈再改批量（100ms 窗口聚合）。MeteringProvider.recordCall 的调用点从主线程路由处迁到这个上报的消费端。
- 验收硬标准：直连路径打开后，复合工具 demo 的调用链账单仍然完整（≥2 个内层模块的独立计量记录）——即 P2-复合工具原验收不因本优化而放宽。

## 3. 兼容与回退
- 新增启动 flag `--directPeerChannels`（默认关闭，稳定一个版本后翻转默认值）。关闭时走现有主线程路由，一行不改。
- ServiceClient.invoke 的对外 API 与语义零变化——callback 签名、错误对象形状、超时行为与主线程路径一致（超时错误码沿用现有值）。
- isRemoteService（HTTP 跨实例）路径不受影响，仅 isRemoteThread 的进程内路径切换。

## 4. Benchmark（产出博客二号素材的硬数字）
perf/ 下新增 cross-worker 基准：主线程路由 vs 直连，各测吞吐与 p50/p99 延迟，payload 三档（1KB/100KB/1MB），并发 1/16/64。输出对比表进 docs/direct-peer-channels.md。**这组数字是替代 PPT 时代 20–30x 旧口径的唯一合法公开数字来源。**

## 5. 实现顺序与验收
```
1. PeerChannel 类 + 主线程 broker（D1/D2）→ 单测：两 worker 直连 echo 往返
2. 失效处理（D4）→ 测试：热重载/kill 目标 worker 的两条路径
3. 鉴权前移（D3）→ 测试：无权模块请求 brokering 被拒
4. 计量上报（D5）→ 测试：直连调用产生计量记录，与主线程路径记录字段一致
5. flag + 回退验证 → 全量测试在 flag 开/关两态下均绿
6. benchmark + 文档（英文 docs/direct-peer-channels.md）
每步单独 commit。
```

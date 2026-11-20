// The error catalogue (docs/superpowers/specs/2026-11-09-logger-design.md §5.3): one table, code ->
// {kind, retryable, httpStatus, mcpCode, en, zh}. It replaces lib/error-info.en-US.json and
// lib/error-info.zh-CN.json; the en/zh texts are theirs, unchanged. Modules define their own codes and
// never raise these (§5.3), so every entry is the runtime's, and every entry is one lib/ raises
// (test/validation/04): 23 codes of the old tables that nothing raised were not carried over.
//
// kind: who should act -- caller (the request was wrong), module (a module's code or spec), operator
// (configuration), runtime (countinghouse itself). retryable: the same call may succeed if retried.
// Both were judged per code for this table (implementer B, 2026-11-09; the reviewer checks them).
//
// httpStatus is what the HTTP edge answers (post-rel caller 400): every REST error answer takes
// its status from here (lib/countinghouse-error.js statusOf, at lib/session.js and the routes
// that answer directly), a module's own error 400 when its module said the caller is at fault,
// else 500. Every caller-kind row is a 4xx (test/validation pins it). A name the caller can't
// use answers one code per route, whatever the reason (MODULE_NOT_LISTED for a device,
// ACTION_NOT_FOUND for an action, JOB_NOT_FOUND for a job): no status or code tells "doesn't
// exist" from "not listed" or "no access". An MCP tool's error is an isError result in an HTTP
// 200, its code and kind in _meta (countinghouse/code, countinghouse/kind); mcpCode is null
// everywhere, and JSON-RPC error codes stay chosen by the request's path (an auth failure on
// tools/call is one: -32603, see the three auth codes' comments).
'use strict';

const CODES = {
  SET_INCORRECT_ACTION_TYPE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Incorrect action type setting",
    zh: "action类型设置错误"},
  CANNOT_SET_ACTION_SERVICE_OBJ_NOT_EXIST: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot set action, service object does not exist, check whether the corresponding serviceID is defined in the API spec",
    zh: "无法设置action, service对象不存在, 请检查API规范中相应serviceID是否已定义"},
  CANNOT_SET_ACTION_ACTION_LIST_NOT_EXIST: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot set action, actionList object does not exist, check whether an actionList object exists under the corresponding serviceID in the API spec",
    zh: "无法设置action, actionList对象不存在, 请检查API规范中相应serviceID下是否存在actionList对象"},
  CANNOT_SET_ACTION_OBJ_NOT_EXIST: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot set action, action does not exist, check whether this action is defined under the corresponding serviceID in the API spec",
    zh: "无法设置action, action不存在, 请检查API规范中相应serviceID下是否存在该action定义"},
  CANNOT_SET_ACTION: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot set action",
    zh: "无法设置action"},
  NO_VALID_DEVICE_SPEC: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid device spec",
    zh: "非法设备规范"},
  CANNOT_GET_DEVICE_SPEC: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot get device spec",
    zh: "无法获取设备规范"},
  SERVICE_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Unknown service",
    zh: "未知服务"},
  DEVICE_IN_ACTION: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Device is processing a call",
    zh: "设备处理调用中"},
  GET_HARDWARE_ADDR_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get device hardware address",
    zh: "获取设备硬件地址失败"},
  DEVICE_SPEC_UPDATE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device spec update failed",
    zh: "设备规范更新失败"},
  DESTROY_DEVICE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to destroy device",
    zh: "销毁应用失败"},
  GET_DEVICE_SCHEMADOC_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get device schema document",
    zh: "获取设备schema文档失败"},
  INVALID_DEVICE_SCHEMADOC: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid device schema document",
    zh: "非法设备schema文档"},
  INVALID_JSON_POINTER: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid JSON pointer",
    zh: "非法JSON指针"},
  POINTER_DEREF_ERROR: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "JSON pointer dereference failed",
    zh: "JSON指针解析失败"},
  // a schema path the caller asked for that names nothing it may see (one
  // under a usable action that isn't there, or under an unusable one: one
  // answer); POINTER_DEREF_ERROR stays the module's document failing
  SCHEMA_PATH_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Nothing is at this schema path",
    zh: "该模式路径下没有内容"},
  PROXY_SERVER_CREATE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to create reverse proxy server",
    zh: "创建反向代理服务器失败"},
  DEVICE_CONNECT_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device connect failed",
    zh: "设备连接失败"},
  INVALID_REDIRECT_URL: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid redirect URL",
    zh: "非法重定向URL"},
  DEVICE_DISCONNECT_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device disconnect failed",
    zh: "设备断开连接失败"},
  // DEVICE_NOT_CONNECTED: kind/retryable: unsure, for review
  DEVICE_NOT_CONNECTED: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Device not connected",
    zh: "设备未连接"},
  DEVICE_SPEC_VALIDATION_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device spec validation failed",
    zh: "设备规范校验失败"},
  INVALID_MODULE_INSTANCE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid device module instance",
    zh: "非法设备模块实例"},
  // DEVICE_OBJECT_CONFLICT: kind/retryable: unsure, for review
  DEVICE_OBJECT_CONFLICT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device object conflict",
    zh: "设备对象冲突"},
  // DEVICE_OFFLINE: kind/retryable: unsure, for review
  DEVICE_OFFLINE: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Device is offline",
    zh: "设备已下线"},
  MODULE_VERIFICATION_FAILED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device module verification failed",
    zh: "设备模块校验失败"},
  // DEVICE_NOT_FOUND: kind/retryable: unsure, for review
  DEVICE_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Device not found",
    zh: "未找到设备"},
  DEVICE_ACTION_CALL_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to call device action",
    zh: "调用设备接口失败"},
  DEVICE_OBJECT_NOT_VALID_CDIF_DEVICE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device object is not a valid CDIF device",
    zh: "设备对象不是合法的CDIF设备"},
  // CORRESPONDING_MODULE_NOT_FOUND: kind/retryable: unsure, for review
  CORRESPONDING_MODULE_NOT_FOUND: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Corresponding device module not found",
    zh: "未找到相应设备模块"},
  LOAD_MODULE_FAIL: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Module load failed",
    zh: "模块加载失败"},
  // #144: the worker did not answer its load within --moduleLoadTimeout (a
  // module that blocks while it is required) and was ended.
  MODULE_LOAD_TIMEOUT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module did not finish loading within --moduleLoadTimeout; its worker was ended -- check that nothing it requires blocks",
    zh: "模块未在 --moduleLoadTimeout 内完成加载，其 worker 已被结束 -- 请检查其加载时是否有阻塞的代码"},
  // MODULE_LOAD_SUPERSEDED: kind/retryable: unsure, for review
  MODULE_LOAD_SUPERSEDED: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A later load, reload or unload of this module took over; this one did nothing",
    zh: "该模块随后的加载、重载或卸载已接管，本次操作未生效"},
  GET_MODULE_INFO_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get module info",
    zh: "模块信息获取失败"},
  REMOVE_MODULE_INFO_FAIL: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to remove the module's registry entry -- nothing was deleted; the server log has the reason",
    zh: "删除模块的注册表记录失败 -- 未删除任何内容；原因见服务器日志"},
  MODULE_PACKAGE_INFO_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid module package info file",
    zh: "模块信息文件非法"},
  MODULE_PACKAGE_NAME_TYPE_ERROR: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Module package name type error",
    zh: "模块名称类型错误"},
  MODULE_VERSION_INFO_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid module version info",
    zh: "模块版本信息不合法"},
  INVALID_MODULE_PATH: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid module path name",
    zh: "模块路径名非法"},
  SCHEMA_COMPILE_ERROR: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Schema compile error",
    zh: "schema编译错误"},
  SERVICEID_NOT_AVAILABLE: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "serviceID not found",
    zh: "未找到serviceID"},
  ACTIONNAME_NOT_AVAILABLE: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "actionName not found",
    zh: "未找到actionName"},
  ARGUMENTS_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid call arguments",
    zh: "调用参数非法"},
  MISSING_OUTPUT_ARGUMENT: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Missing output field in the output data",
    zh: "未找到输出数据中的output字段"},
  INPUT_DATA_VALIDATION_FAIL: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Input data validation error",
    zh: "输入数据校验错误"},
  OUTPUT_DATA_VALIDATION_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Output data validation error",
    zh: "输出数据校验错误"},
  ACTION_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Action not found",
    zh: "未找到action"},
  INPUT_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Input object not found",
    zh: "未找到input对象"},
  ACTION_NOT_IMPLEMENTED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Action not implemented",
    zh: "action未实现"},
  DEVICE_INVOKE_EXCEPTION: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device interface call threw an exception",
    zh: "设备接口调用抛出异常"},
  // DEVICE_INVOKE_FAIL: kind/retryable: unsure, for review
  DEVICE_INVOKE_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device call failed",
    zh: "设备调用失败"},
  // DEVICE_ACCESS_ERROR: kind/retryable: unsure, for review
  DEVICE_ACCESS_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device access failed",
    zh: "设备访问失败"},
  DEVICE_NOT_RESPONDING: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Device is not responding",
    zh: "设备无响应"},
  // REDIS_CLIENT_ERROR: kind/retryable: unsure, for review
  REDIS_CLIENT_ERROR: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Redis client error",
    zh: "redis客户端错误"},
  SYSTEM_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "System error",
    zh: "系统错误"},
  // SYSTEM_ERROR_USERDB_NA: kind/retryable: unsure, for review
  // SYSTEM_ERROR_USERDB_NA: HTTP: this row's status on every route (lib/countinghouse-error.js answerError, post-rel caller 400); MCP: JSON-RPC -32603 without the code on tools/call, plain or task-augmented (gateway.js userAuth), and on tasks/* (resolveGatedIdentity); a tool error result only from countinghouse_check_balance (pinned by test/mcp-contract/07)
  SYSTEM_ERROR_USERDB_NA: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "User database unavailable",
    zh: "用户数据库不可用"},
  // SYSTEM_ERROR_UNKNOWN_USER: HTTP: 401 on every route, with WWW-Authenticate (answerError, post-rel caller 400); MCP: JSON-RPC -32603 without the code on tools/call, plain or task-augmented (gateway.js userAuth), and on tasks/* (resolveGatedIdentity); a tool error result only from countinghouse_check_balance (pinned by test/mcp-contract/07)
  SYSTEM_ERROR_UNKNOWN_USER: {kind: 'caller', retryable: false, httpStatus: 401, mcpCode: null,
    en: "Unknown user",
    zh: "未知用户"},
  // USER_HAS_NO_DEVICE: HTTP: on a device route answered as one not there or not listed, MODULE_NOT_LISTED 404 (routes/user.js, post-rel caller 400), elsewhere this row's 403; MCP: on tools/call, plain or task-augmented, a known key's tool outside its grants answers -32602 "unknown tool" (gateway.js handleToolsCall), and this only from userAuth's second gate within a grant set's 5 s; -32603 without the code on tasks/* (resolveGatedIdentity); a tool error result only from countinghouse_check_balance (pinned by test/mcp-contract/07)
  USER_HAS_NO_DEVICE: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "This apiKey does not have access to this device: ask the operator to add it to the apiKey's devices list in the auth config",
    zh: "该 apiKey 无权访问此设备，请联系管理员将其加入鉴权配置中该 apiKey 的设备列表"},
  // ADMIN_REQUIRED: HTTP: 403 (routes/admin-only.js); on MCP none: an authoring tool for a key that is no admin's is an unknown tool, as it is not listed to it (#458)
  ADMIN_REQUIRED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "This operation requires an admin apiKey",
    zh: "此操作需要管理员 apiKey"},
  AUTH_RELOAD_INVALID: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The auth configuration was not reloaded, because it failed its checks -- the configuration in use is unchanged; fix the problem named and reload again",
    zh: "认证配置未重新加载，因为它未通过检查 -- 当前使用的配置保持不变；请修正所列问题后再次重新加载"},
  // IDENTITY_NOT_FOUND: /identity-lookup and countinghouse_lookup_identity (lib/identity.js), admin only
  IDENTITY_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "No user has this id on this server",
    zh: "本服务器上没有用户使用此 id"},
  RESTART_MODULE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to restart module",
    zh: "重启模块失败"},
  UNLOAD_MODULE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to unload module",
    zh: "卸载模块失败"},
  ADD_JOB_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to add job",
    zh: "添加任务失败"},
  GET_JOB_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get job info",
    zh: "获取任务信息失败"},
  REMOVE_JOB_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to remove job",
    zh: "删除任务失败"},
  DEVICE_CONFIG_LOAD_FAIL: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get app config info",
    zh: "获取应用配置信息失败"},
  DEVICE_ID_INVALID_OR_NULL: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid device ID",
    zh: "非法设备ID"},
  PEER_GONE: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Direct peer channel is no longer valid",
    zh: "直连通道已失效"},
  // PEER_NOT_GRANTED: kind/retryable: unsure, for review
  PEER_NOT_GRANTED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Refused: this direct peer channel was not granted for that device",
    zh: "已拒绝：此直连通道未获准访问该设备"},
  PEER_CHANNEL_TIMEOUT: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Direct peer channel call timed out",
    zh: "直连调用超时"},
  PEER_SELF_TARGET: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Target device is hosted by the requesting worker itself, direct peer channel not applicable",
    zh: "目标设备由发起调用的 worker 自身承载，不支持建立直连通道"},
  PEER_NO_HANDLER: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "No peer-invoke handler registered on the remote side",
    zh: "对端未注册直连调用处理器"},
  // Step 3c: a hop stated a usageCall its worker was not dispatched (a
  // module forging another caller's call id). The hop is not forwarded.
  USAGE_CALL_FOREIGN: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: 'A hop stated a usage call its worker was not given',
    zh: '调用链中的一跳声明了不属于其工作线程的用量调用'},
  // Local-mode spec §5: `receipt` at the top of a tool's output is the
  // runtime's (the receipt of what the call read and returned).
  RECEIPT_RESERVED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A tool's output may not have a top-level field named receipt: the runtime adds the receipt",
    zh: "工具输出的顶层不能有名为 receipt 的字段：收据由运行时添加"},
  // A module the caller's listing does not show: a part another module calls
  // (local-mode spec §3), a non-scenario module under the single-identity
  // profile, one going on or off (#413 rev 3, section 5.5), or, over HTTP's
  // spec and schema routes, any of these (#447). Worded to be true for every
  // reason, for a user who set no key (the reviewer, 2026-11-19).
  MODULE_NOT_LISTED: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "This tool is not available to this caller here",
    zh: "此工具在此处对该调用方不可用"},
  // A module whose part (named in countinghouse.calls) is not installed or
  // not available (M6: #413 rev 3 section 11, a module, never a pack).
  PART_MISSING: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A module this one calls is not installed or not available, so it was not loaded",
    zh: "此模块调用的某个模块未安装或不可用，因此未加载"},
  // A module's bare tool name is already a listed tool's or a built-in's.
  TOOL_NAME_TAKEN: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A module's tool name is already taken by another tool, so the module was not loaded",
    zh: "该模块的工具名已被其他工具占用，因此未加载该模块"},
  // The same for a prompt's name (the reviewer's #340 review, 3): a clash is
  // refused at load, never renamed at listing.
  PROMPT_NAME_TAKEN: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A module's prompt name is already taken by another prompt, so the module was not loaded",
    zh: "该模块的提示名已被其他提示占用，因此未加载该模块"},
  // Two scenarios need one module at two versions (packs in place, part 2): a
  // runtime holds one version of a module. The zh text is the reviewer's.
  PART_VERSION_CONFLICT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{name} is needed at {versions}; a runtime holds one version of a module, so {scenario} was not loaded",
    zh: "{scenario} 未加载：它需要 {name} 的 {versions} 版本，而一个运行时只能装载一个模块的一个版本。"},
  MODULE_NO_DEVICE_ONLINE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device module produced no usable device",
    zh: "设备模块未产出可用设备"},
  QUERY_DEVICE_ON_MAIN_THREAD: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot look up a device from the main thread in worker-thread mode",
    zh: "worker 线程模式下禁止在主线程中查找设备"},
  // one answer for a job the caller can't see: none with that id, or one
  // another key owns (get-job, remove-job; post-rel caller 400: no probing
  // which jobs exist)
  JOB_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Job not found",
    zh: "未找到任务"},
  // a job request the caller got wrong (no opts, no name, a bound
  // exceeded, a remove with no isRepeat flag): the caller's, 400 (post-rel
  // caller 400's medium, 7); ADD_JOB_ERROR and REMOVE_JOB_ERROR stay for
  // the runtime's own failures
  JOB_OPTS_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "The job request is not valid",
    zh: "任务请求无效"},
  MODULE_ASSEMBLY_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Handler-map module assembly failed",
    zh: "handler map 模块装配失败"},
  // A module answered with a code of this catalogue (ctx.error's code, or
  // one set on its error after): a module defines only its own codes (the
  // logger spec, section 12, 1), so its error never passes for the
  // runtime's. {code}: that code's name, nothing else of the module's.
  MODULE_CODE_RESERVED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: 'the module answered with the runtime\'s own code {code}, which a module may not use',
    zh: '模块返回了运行时自身的错误码 {code}，模块不得使用该错误码。'},
  MODULE_HANDLER_MISMATCH: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Handler map does not match api.json",
    zh: "handler map 与 api.json 不匹配"},
  // R2-1 Task 3 (lib/call-tokens.js): a worker's hop, device query, remote
  // call or peer announcement cited a per-call token the main thread did not
  // issue, that has expired, or that was issued to another worker.
  CALL_TOKEN_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Refused: the call's token is unknown, expired or not this worker's, so the hop cannot be billed or authorized",
    zh: "已拒绝：本次调用的令牌未知、已过期或不属于本工作线程，该跳转无法计费或授权"},
  // HOP_CHAIN_TOO_DEEP (R2-1 Task 3, the review of #141): a hop whose call
  // chain is already MAX_CHAIN_DEPTH deep (lib/call-tokens.js); mutual
  // recursion between composites is what reaches it.
  HOP_CHAIN_TOO_DEEP: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Refused: the call chain is too deep (a hop inside a hop, past the limit); composites must not call each other without end",
    zh: "已拒绝：调用链过深（跳转嵌套超过上限）；组合模块之间不得无限互相调用"},
  // Lean worker step 1(b) (lib/validator-pool.js; the reviewer's texts,
  // 2026-11-13). Fields: {module}, {action}, {which} (per locale: input or
  // output), {ms}; never a key or a value.
  VALIDATION_TIMEOUT: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its {which} was not validated within {ms} ms, so the call was refused",
    zh: "{module}/{action}：{which}未能在 {ms} 毫秒内完成校验，调用已被拒绝。"},
  // A hop's input over --maxOutputBytes (the one cap; the reviewer's ruling
  // and texts, 2026-11-14): refused on the main thread from the bytes'
  // length, before any validator or the callee sees it. {module}/{action}:
  // the called action. A module's own hop, never the HTTP client's request:
  // 500, as OUTPUT_TOO_LARGE. Fields: {module}, {action}, {bytes}, {max}.
  INPUT_TOO_LARGE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its input is {bytes} bytes, over the {max}-byte limit (--maxOutputBytes), so the call was refused. To allow more: {raise}",
    zh: "{module}/{action}：输入为 {bytes} 字节，超过 {max} 字节的上限（--maxOutputBytes），调用已被拒绝。如需放宽：{raise}"},
  // A module's reply over --maxOutputBytes, measured in its own worker before
  // it is posted (lib/lean-worker.js). Fields: {module}, {action}, {bytes},
  // {max}; the reviewer's texts, 2026-11-13.
  // #170: a message from a module's worker to the main thread over the cap
  // (--maxOutputBytes plus 64 KiB), refused in the worker before it is posted.
  MESSAGE_TOO_LARGE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A message from the module to the runtime was larger than allowed -- send less at once",
    zh: "模块发给运行时的消息超过上限 -- 请减少单次发送的数据量"},
  OUTPUT_TOO_LARGE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its output is {bytes} bytes, over the {max}-byte limit (--maxOutputBytes), so the call was refused. To allow more: {raise}",
    zh: "{module}/{action}：输出为 {bytes} 字节，超过 {max} 字节的上限（--maxOutputBytes），调用已被拒绝。如需放宽：{raise}"},
  // A module's output holding a Buffer, a typed array or a DataView, which
  // is not JSON (MCP completeness, spec section 1; lib/serialized-result.js
  // serializeOutput, in the module's worker). Fields: {module}, {action},
  // {field} (a JSON pointer into the output).
  OUTPUT_NOT_JSON: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its output holds a Buffer, typed array or DataView at {field}, which is not JSON, so the call was refused: return buf.toString('base64') in a field its output schema declares contentEncoding: base64.",
    zh: "{module}/{action}：输出在 {field} 处含有 Buffer、类型化数组或 DataView，不是 JSON，调用已被拒绝：请在输出 schema 中声明为 contentEncoding: base64 的字段里返回 buf.toString('base64')。"},
  // The result store (MCP completeness M5, lib/store/blobs.js) has no room
  // for a value that would be stored and linked: nothing is evicted early,
  // since a link promises its retention. Fields: {limit}, the option whose
  // limit was reached: maxOutputBytes (one value over three quarters of it),
  // resourceQuotaBytes, resourceQuotaItems or resourceStoreBytes.
  // A result with a binary value that must be stored (M6: a resource type,
  // or past --inlineContentBytes) from a call with no caller to own it (a
  // debug call with no key).
  RESULT_NOT_STORABLE: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: 'this result has a binary value that must be stored and read back, and the call has no caller to store it for; call with an API key',
    zh: '此结果含有必须存储并读回的二进制值，而本次调用没有可归属的调用方；请使用 API key 调用。'},
  RESULT_STORE_FULL: {kind: 'runtime', retryable: true, httpStatus: 507, mcpCode: null,
    en: "the result store has no room for this result's stored value ({limit}), so the call's result was not stored; stored results expire with --resourceRetention, or the operator can raise --{limit}.",
    zh: "结果存储没有空间保存此结果的值（{limit}），调用结果未被存储；已存储的结果会按 --resourceRetention 过期，或可请运维提高 --{limit}。"},
  // The result store (--store redis) did not answer a stored result's write
  // or read within its deadline, or Redis is down (the back-sweep, 11-18:
  // #16's rule, calls answer with Redis down, for results with a binary
  // value). Nothing was stored; the call can be made again.
  RESULT_STORE_UNAVAILABLE: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: 'the result store did not answer in time, so this result\'s binary value was not stored; try the call again',
    zh: '结果存储未能及时响应，此结果的二进制值未被存储；请重试本次调用。'},
  // A result holding more binary values than one answer may carry (MCP
  // completeness, spec section 1; lib/binary-fields.js): an array counts each
  // item. Fields: {module}, {action}, {max}.
  TOO_MANY_BINARY_VALUES: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its result holds more than {max} binary values (fields declared contentEncoding: base64, an array counting each item), so the call was refused.",
    zh: "{module}/{action}：结果中的二进制值超过 {max} 个（声明为 contentEncoding: base64 的字段，数组按元素计数），调用已被拒绝。"},
  // An input's stalls are held against its caller (the review of #165): only
  // that caller's calls to the module are refused, for a while. The zh text
  // is the reviewer's.
  VALIDATION_CALLER_THROTTLED: {kind: 'module', retryable: true, httpStatus: 429, mcpCode: null,
    en: "{module}/{action}: this caller's inputs to the module kept missing the validation deadline ({stalls} in {minutes} minutes), so its calls to the module are refused for {seconds} s",
    zh: "{module}/{action}：该调用方发给此模块的输入多次未能在校验期限内完成（{minutes} 分钟内 {stalls} 次），其对此模块的调用将在 {seconds} 秒内被拒绝。"},
  // countinghouse_settings (packs in place, part 2; spec #168 section 3, the
  // reviewer's zh texts, 2026-11-14). Fields: {name}, {value}, {bounds};
  // {problem} for a file that cannot be used.
  SETTING_UNKNOWN: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "There is no setting named {name}; the settings that can be changed are in get's answer.",
    zh: "没有名为 {name} 的设置；可以修改的设置见 get 的结果。"},
  SETTING_OUT_OF_BOUNDS: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "The value {value} for {name} is outside the allowed range ({bounds}); nothing was changed.",
    zh: "{name} 的值 {value} 超出了允许的范围（{bounds}），未作修改。"},
  SETTING_LOOSENS_A_GUARD: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Changing {name} to {value} would loosen a guarding setting, which can only be done from a terminal; nothing was changed. To change it, run `{command}` in a terminal yourself.",
    zh: "把 {name} 改为 {value} 会放宽一项防护设置，这只能在终端里修改，设置未更改。如需修改，请自己在终端里运行 `{command}`。"},
  // Part 3 (guarding settings by conversation): a loosening conversation may
  // ask for, not confirmed by the user; addressed to the user, not the agent.
  SETTING_NEEDS_CONFIRMATION: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Changing {name} to {value} loosens a guarding setting, so it needs your own confirmation; nothing was changed. To allow this, run `{command}` in a terminal yourself. That change is kept, not just for this session, and a value above what this runtime started with takes effect when it next starts.",
    zh: "把 {name} 改为 {value} 会放宽一项防护设置，需要你亲自确认，设置未更改。如需允许，请自己在终端里运行 `{command}`。这一修改会一直保留，不只限于本次运行；高于本次运行启动时的值，要到下次启动时才生效。"},
  // The shared runtime (C1 part 2's guard, until per-session settings, B2):
  // a session changes no setting; the terminal does.
  SETTING_TERMINAL_ONLY_SHARED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "On this shared runtime, settings are changed from a terminal for now; nothing was changed. To change {name}, run `{command}` in a terminal yourself.",
    zh: "在这个共享运行时上，目前只能在终端里修改设置，本次没有任何更改。如需修改 {name}，请自己在终端里运行 `{command}`。"},
  // Part 3, section 4: the operator's ceiling (lib/settings-ceiling.js).
  SETTING_ABOVE_CEILING: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "{name} {value} is above the ceiling this machine's operator set ({ceiling}); nothing was changed.",
    zh: "{name} {value} 超出了本机管理员设定的上限（{ceiling}），设置未更改。"},
  SETTING_FORBIDDEN_BY_CEILING: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "{name} cannot be changed to {value} on this machine: its operator's ceiling forbids it; nothing was changed.",
    zh: "在本机上不能把 {name} 改为 {value}：本机管理员设定的上限禁止这样做，设置未更改。"},
  SETTING_CEILING_UNTRUSTED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "The operator's ceiling file {file} cannot be trusted ({problem}), so no setting is loosened; nothing was changed.",
    zh: "管理员的上限文件 {file} 不可信（{problem}），因此任何设置都不会被放宽，设置未更改。"},
  // M5b (#449's high review, 5; round 4, 8): a module turned on, or a name not
  // loaded turned off, while ch-local's record of the installed modules
  // (modules.json) cannot be read: said as it is
  SETTING_RECORD_UNREADABLE: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "ch-local's record of the installed modules can't be read right now, so {name} can't be changed here; nothing was changed. Try again in a moment, or run `{command}` in a terminal yourself.",
    zh: "目前无法读取 ch-local 的已安装模块记录，因此不能在这里修改 {name}，设置未更改。请稍后再试，或自己在终端里运行 `{command}`。"},
  // Part 3, section 2: a loosening confirmed in the client's dialog
  // (lib/settings-confirm.js, lib/settings-tool.js confirm).
  // A module's question (ctx.ask; the MCP completeness design, section 8).
  // ASK_PENDING ends the handler's first pass: the call is answered with the
  // question (input_required) and the handler runs again, from the top, on
  // the client's retry. ASK_UNAVAILABLE is one a module may catch to fall
  // back. ASK_NOT_DECLARED is the module's own mistake.
  ASK_PENDING: {kind: 'runtime', retryable: false, httpStatus: 409, mcpCode: null,
    en: "A question for the user is pending: the call is answered with it, and runs again from the top once the user has answered. Let this error pass.",
    zh: "有一个问题正在等待用户回答：本次调用以该问题作答，用户回答后将从头重新运行。请让此错误继续向上传递。"},
  ASK_UNAVAILABLE: {kind: 'runtime', retryable: false, httpStatus: 409, mcpCode: null,
    en: "No one can be asked here: the client offered no form, the call did not come from an MCP client that can answer one, it runs as a task whose client offered no form or with too many tasks already waiting on questions, module questions are turned off, or no valid answer came in three rounds.",
    zh: "此处无法向任何人提问：客户端未提供表单能力、调用并非来自能够作答的 MCP 客户端、调用作为任务运行而其客户端未提供表单能力或已有过多任务在等待回答、模块提问已被关闭，或三轮内没有得到有效回答。"},
  // A task's question waited past its time (M22, lib/task-asks.js): the
  // task fails with it, and nothing runs again.
  ASK_EXPIRED: {kind: 'runtime', retryable: false, httpStatus: 410, mcpCode: null,
    en: "The task's question was not answered in time: the task has stopped, and nothing more of it will run. Call the tool again to start over.",
    zh: "该任务的问题未在规定时间内得到回答：任务已停止，不会再运行。请重新调用工具以重新开始。"},
  // A retry's requestState (lib/request-state.js): not this call's, expired
  // or already used. One answer, whatever failed: a caller learns nothing
  // of which. ASK_STATE_UNCHECKED is not that: the store could not say
  // whether the state was used, and nothing ran. The same retry may be sent
  // again, but a store that timed out may still have recorded the state as
  // used: the retry is then refused, and the caller asks again.
  ASK_STATE_INVALID: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "That answer cannot be taken for this call: its state is not one this runtime gave for this call, has expired, or was already used. Call the tool again without it.",
    zh: "无法为本次调用接受该回答：其状态并非本运行时为此调用发出，或已过期，或已被使用。请不带该状态重新调用工具。"},
  ASK_STATE_UNCHECKED: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The answer could not be checked just now: the store did not say whether its state was used. Nothing ran. The answer may no longer be usable: send the same retry once, and if it is refused, call the tool again without it to be asked again.",
    zh: "暂时无法核对该回答：存储未能确认其状态是否已被使用。未执行任何操作。该回答可能已无法使用：请原样重试一次；若被拒绝，请不带该回答重新调用工具，以便再次提问。"},
  ASK_NOT_DECLARED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "This action declares no such question, or a value for one of its placeholders is missing or is not a string, a number or a boolean",
    zh: "此操作未声明该问题，或其某个占位符的值缺失，或不是字符串、数字或布尔值"},
  SETTING_CONFIRMATION_INVALID: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "That confirmation is not one this runtime gave for this change, or it was replaced by a newer request; nothing was changed. Ask again for a new one.",
    zh: "该确认不是本次运行为此修改发出的，或已被更新的请求取代，设置未更改。请重新提出请求。"},
  SETTING_CONFIRMATION_EXPIRED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "That confirmation has expired (it lasts 120 seconds); nothing was changed.",
    zh: "该确认已过期（有效期 120 秒），设置未更改。"},
  SETTING_CONFIRMATION_USED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "That confirmation was already used; nothing more was changed.",
    zh: "该确认已被使用过，未再作修改。"},
  SETTING_DECLINED_THIS_START: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loosening {name} was declined, or left unanswered, in this session, so it is not asked again until countinghouse restarts; nothing was changed. To allow it, run `{command}` in a terminal yourself.",
    zh: "放宽 {name} 已在本次运行中被拒绝或未获答复，在 countinghouse 重新启动之前不会再次询问，设置未更改。如需允许，请自己在终端里运行 `{command}`。"},
  // A shared runtime's session (B2 Task 5): its lock lasts the session's
  // life, and it falls on a decline or on two forms left unanswered. A kind
  // the latch locked (its client could answer a form by itself) is
  // SETTING_CLIENT_NOT_CONFIRMED, below.
  SETTING_DECLINED_THIS_SESSION: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loosening {name} is not asked again in this session (it was declined or left unanswered here); nothing was changed. To allow it, run `{command}` in a terminal yourself.",
    zh: "本会话中不会再询问是否放宽 {name}（此前已被拒绝或未获答复），设置未更改。如需允许，请自己在终端里运行 `{command}`。"},
  // A session's lock restored across a runtime restart: whether it was a
  // decline or a latch before it is not known here, so it says neither
  // (the reviewer's ruling (c) on #337).
  SETTING_LOCKED_THIS_SESSION: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loosening {name} is not available to change in this session; nothing was changed. To allow it, run `{command}` in a terminal yourself.",
    zh: "本会话中无法更改放宽 {name}，设置未更改。如需允许，请自己在终端里运行 `{command}`。"},
  // A session whose client said its configuration could answer a form by
  // itself (the latch, N1): never asked in it, and never said to be a
  // decline. {why} is lib/conditions-why.js's sentence.
  SETTING_CLIENT_NOT_CONFIRMED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loosening {name} is not asked in this session: {why}; nothing was changed. To allow it, run `{command}` in a terminal yourself.",
    zh: "本会话中不会询问是否放宽 {name}：{why}；设置未更改。如需允许，请自己在终端里运行 `{command}`。"},
  SETTING_CHANGED_MEANWHILE: {kind: 'caller', retryable: false, httpStatus: 409, mcpCode: null,
    en: "{name} was changed while you were asked, so the confirmed change was not applied; nothing was changed.",
    zh: "在征求你确认期间 {name} 已被修改，因此已确认的修改未被应用，设置未更改。"},
  SETTING_CEILING_CHANGED_MEANWHILE: {kind: 'caller', retryable: true, httpStatus: 409, mcpCode: null,
    en: "This machine's operator ceiling changed while you were asked about {name}, so the confirmed change was not applied; nothing was changed. Ask again to see it under the ceiling now in force.",
    zh: "在征求你确认 {name} 期间，本机操作员设定的上限已更改，因此已确认的修改未被应用，设置未更改。请重新发起请求，以按当前上限处理。"},
  SETTING_NOT_APPLIED: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The change to {name} for this start could not be applied ({problem}); nothing was changed.",
    zh: "本次运行对 {name} 的修改未能应用（{problem}），设置未更改。"},
  // the same for a shared runtime's session, whose change was its own
  SETTING_NOT_APPLIED_THIS_SESSION: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The change to {name} for this session could not be applied ({problem}); nothing was changed.",
    zh: "本会话对 {name} 的修改未能应用（{problem}），设置未更改。"},
  // and for a change one session confirmed for all sessions (B2 Task 5b)
  SETTING_NOT_APPLIED_ALL_SESSIONS: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The change to {name} for all sessions could not be applied ({problem}); nothing was changed.",
    zh: "对所有会话的 {name} 修改未能应用（{problem}），设置未更改。"},
  SETTINGS_BUSY: {kind: 'caller', retryable: true, httpStatus: 409, mcpCode: null,
    en: "Another change to the settings is under way; nothing was changed. Try again in a moment.",
    zh: "另一个设置修改正在进行，本次未作任何修改。请稍后再试。"},
  SETTINGS_FILE_INVALID: {kind: 'caller', retryable: false, httpStatus: 409, mcpCode: null,
    en: "The settings file cannot be used ({problem}); nothing was changed. The user can fix it, or reset it with `ch-local settings reset` in a terminal.",
    zh: "设置文件无法使用（{problem}），本次未作任何修改。用户可以修正该文件，或在终端里运行 `ch-local settings reset` 重置。"},
  SETTING_NOT_RECORDED: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "The change could not be recorded in the settings history; nothing was changed.",
    zh: "这次修改无法记入设置历史，因此未作任何修改。"},
  VALIDATION_QUARANTINED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}: its calls are refused after repeated validation timeouts, until the module is reloaded",
    zh: "{module}：多次校验超时，该模块的调用将被拒绝，直到模块重新加载。"},
  // One module format (lean worker, step 1; reviewer's texts, 2026-11-13). Fields, filled in by
  // CountinghouseError.withFields (lib/module-layout.js raises it): {name}, the module's name; {file},
  // what makes its main entry (package.json "main": "device.js", or index.js).
  // R1 (shared-runtime design #236, section 4a): a module's state
  // declaration, countinghouse.state in its package.json (lib/module-state.js)
  MODULE_STATE_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}: countinghouse.state is {value}; it must be \"shared\" or \"per-session\", so the module was not loaded",
    zh: "{module}：countinghouse.state 的值为 {value}，必须是 \"shared\" 或 \"per-session\"，因此未加载该模块。"},
  SETTING_REQUIRED: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "{module} needs a setting: {settings}. {hint}",
    zh: "{module} 需要一个设置：{settings}。{hint}"},
  // A module's setting changed in conversation (the module-level
  // configuration design, section 4.4; lib/settings-tool.js): a hint names
  // the setting and never carries a value.
  SETTING_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "{name} was not changed: {reason}.",
    zh: "{name} 未作修改：{reason}。"},
  SETTING_MODULE_NEEDS_CONFIRMATION: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "This change to {name} needs your own confirmation; nothing was changed. To make it, run `{command}` at a terminal yourself.",
    zh: "对 {name} 的这一修改需要你亲自确认，设置未更改。如需修改，请自己在终端里运行 `{command}`。"},
  SETTING_FIXED_BY_CEILING: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "{name} is fixed by this machine's operator (its ceiling); nothing was changed.",
    zh: "{name} 由本机管理员设定为固定值（上限文件），设置未更改。"},
  SETTING_CURSOR_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "That cursor is not one get gave; call get without a cursor to start again.",
    zh: "这个游标不是 get 给出的；请不带游标重新调用 get。"},
  // #449's high review, round 3, 6: the rows a cursor was cut from changed
  // (a module installed, removed, loaded or unloaded meanwhile)
  SETTING_CURSOR_STALE: {kind: 'caller', retryable: false, httpStatus: 409, mcpCode: null,
    en: "The list of settings changed since that page was given, so nothing after it is shown; call get without a cursor to start again.",
    zh: "自给出那一页以来，设置列表已发生变化，因此不再显示其后的内容；请不带游标重新调用 get。"},
  // a module that declares settings, called before its settings state is
  // there (lib/settings-gate.js): nothing run
  SETTING_NOT_READY: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The settings of {module} are not ready yet; nothing was run. Try again in a moment.",
    zh: "{module}的设置尚未就绪，未执行任何操作。请稍后再试。"},
  // module settings run only with worker threads (the user's decision,
  // 11-18; lib/module-manager.js)
  SETTINGS_NEED_WORKER_THREADS: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module} declares settings, which run only with worker threads (--workerThread); this version was not loaded (a version already loaded keeps serving).",
    zh: "{module} 声明了设置，而设置只能在工作线程模式（--workerThread）下运行，因此未加载这一版本（已加载的版本继续运行）。"},
  SETTINGS_DECLARATION_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}: its settings declaration (countinghouse.settings) is invalid: {problem}, so the module was not loaded",
    zh: "{module}：其设置声明（countinghouse.settings）无效：{problem}，因此未加载该模块。"},
  MODULE_NEEDS_SESSIONS: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module} keeps state per session, which needs the shared runtime's sessions; it can't be loaded on the HTTP hosting profile",
    zh: "{module} 按会话保存状态，这需要共享运行时的会话；无法在 HTTP 托管模式下加载。"},
  MODULE_STATE_CHANGED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}: countinghouse.state changed from {from} to {to}; a loaded module's state can't change in place, so unload it first, then load it",
    zh: "{module}：countinghouse.state 从 {from} 变为 {to}；已加载模块的状态无法就地更改，请先卸载，再重新加载。"},
  // R1: a per-session module's worker for one session, ended under a call
  // (a crash or a limit): that session's next call starts a fresh one.
  SESSION_WORKER_ENDED: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module's worker for this session ended (a resource limit or a crash) while this was in progress. Retry: this session's next call starts a fresh worker, whose in-memory state starts empty; the server log has the reason",
    zh: "本会话的模块 worker 在处理过程中退出（资源限制或崩溃）。请重试：本会话的下一次调用会启动新的 worker，其内存中的状态将从空开始；原因见服务器日志"},
  // R1: a per-session module's worker for one session that could not start
  // (its partition could not be made, its worker failed to load). Its own
  // error is logged: it can name the session and a path, and this text goes
  // to a calling module or a job's history.
  SESSION_WORKER_NOT_STARTED: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module's worker for this session could not start; the server log has the reason",
    zh: "无法为本会话启动该模块的 worker；原因见服务器日志"},
  // R1: the supervisor's rule for one (module, session): {module}, {minutes}
  // (its window). Other sessions run on.
  MODULE_SESSION_PAUSED: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "{module}'s worker for this session stopped repeatedly, so it is paused for this session; it starts again after {minutes} minutes, or once the module is reloaded. Other sessions are not affected; the server log has the reason",
    zh: "{module} 在本会话中的 worker 反复退出，因此已在本会话中暂停；{minutes} 分钟后或模块重新加载后会再次启动。其他会话不受影响；原因见服务器日志"},
  // {max}: --maxSessionWorkers. Retryable: a slot frees when a call ends.
  SESSION_WORKERS_BUSY: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "All {max} per-session module workers are busy with calls, so none could be started for this one; retry shortly",
    zh: "全部 {max} 个按会话运行的模块 worker 都在处理调用，无法为本次调用启动新的 worker；请稍后重试"},
  // {name}: the module (its directory's name when its package.json can't be
  // read for one). The high review of #452.
  MODULE_PACKAGE_BOM: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{name}: package.json starts with a byte-order mark; save it without one",
    zh: "{name}：package.json 以字节顺序标记（BOM）开头；请去掉它后重新保存"},
  MODULE_LAYOUT_UNSUPPORTED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{name}: a module is api.json, schema.json and handlers/<service>/<action>.js; this one has {file} and no handlers/ directory. See docs/module-development.md.",
    zh: "{name}：模块由 api.json、schema.json 和 handlers/<服务>/<动作>.js 组成；这个模块有 {file}，却没有 handlers/ 目录。见 docs/module-development.md。"},
  // HOP_IDENTITY_UNRESOLVED: kind/retryable: unsure, for review
  HOP_IDENTITY_UNRESOLVED: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Refused: the calling identity for this inner hop could not be resolved, so the call cannot be billed to anyone",
    zh: "已拒绝：无法解析本次内层跳转的调用方身份，该调用无法计费到任何账户"},
  MODULE_COMPOSITION_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Module composition declaration is invalid",
    zh: "模块组合声明无效"},
  // RC1-min (lib/remote/, docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md): the module's own
  // declaration, credential setup or call.
  REMOTE_DECLARATION_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module's remote MCP server declaration (countinghouse.remotes) is invalid",
    zh: "模块的远程 MCP 服务器声明（countinghouse.remotes）无效"},
  REMOTE_CREDENTIAL_NOT_ALLOWED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The remote's credential is not allowed for its origin by the operator's --remoteCredentials file; the remote is disabled",
    zh: "运营方的 --remoteCredentials 文件未允许向该远程源发送此凭据，远程已停用"},
  REMOTE_CREDENTIAL_MISSING: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The remote's credential variable is allowed but was not set when the module loaded",
    zh: "远程凭据变量已获允许，但模块加载时未设置"},
  REMOTE_UNDECLARED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: the module declares no such remote in \"countinghouse.remotes\" (package.json)",
    zh: "ctx.call 已拒绝：模块未在 \"countinghouse.remotes\"（package.json）中声明该远程"},
  REMOTE_ARGS_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: a remote call takes the address remote:<name>/<tool> and a plain JSON object of arguments",
    zh: "ctx.call 已拒绝：远程调用需要地址 remote:<name>/<tool> 和普通 JSON 对象参数"},
  // RC1-min (lib/remote/client.js, docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md section 4):
  // a module's remote MCP server failed in transport or protocol. A tool's
  // own error (isError) is a result, never one of these.
  REMOTE_UNREACHABLE: {kind: 'runtime', retryable: true, httpStatus: 502, mcpCode: null,
    en: "The remote MCP server could not be reached (DNS, connection or TLS failure, or a redirect to another origin, which is refused)",
    zh: "无法连接远程 MCP 服务器（DNS、连接或 TLS 失败，或被拒绝的跨源重定向）"},
  // JOB_TIMEOUT: a job's run past its own timeout, else --jobTimeout (both
  // runners, lib/job-control-common.js timeoutError): stored as its
  // failedReason, "JOB_TIMEOUT: <text>", so a task's failure carries the code
  JOB_TIMEOUT: {kind: 'runtime', retryable: true, httpStatus: 504, mcpCode: null,
    en: "The job did not finish within its timeout ({seconds} s), so it failed; an answer after that is dropped",
    zh: "任务未在其超时时间（{seconds} 秒）内完成，因此失败；此后的应答将被丢弃"},
  REMOTE_TIMEOUT: {kind: 'runtime', retryable: true, httpStatus: 504, mcpCode: null,
    en: "The remote MCP server did not answer within --remoteTimeout",
    zh: "远程 MCP 服务器未在 --remoteTimeout 内应答"},
  REMOTE_AUTH_FAILED: {kind: 'runtime', retryable: false, httpStatus: 502, mcpCode: null,
    en: "The remote MCP server refused the credential (401 or 403)",
    zh: "远程 MCP 服务器拒绝了凭据（401 或 403）"},
  REMOTE_PROTOCOL: {kind: 'runtime', retryable: false, httpStatus: 502, mcpCode: null,
    en: "The remote MCP server's answer is not a valid MCP response",
    zh: "远程 MCP 服务器的应答不是有效的 MCP 响应"},
  REMOTE_RESULT_TOO_LARGE: {kind: 'runtime', retryable: false, httpStatus: 502, mcpCode: null,
    en: "The remote MCP server's answer is over --remoteMaxBytes",
    zh: "远程 MCP 服务器的应答超过 --remoteMaxBytes"},
  REMOTE_ADDRESS_REFUSED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The remote's host resolves to a loopback, private or Redis-endpoint address, which is refused",
    zh: "远程主机解析到回环、私有或 Redis 端点地址，已拒绝"},
  CTX_CALL_NOT_READY: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "ctx.call is not ready yet: this module's composition has not been verified yet -- retry shortly, the auth config is not necessarily wrong",
    zh: "ctx.call 尚未就绪：该模块的组合关系还未完成校验 -- 请稍后重试，这不一定说明鉴权配置有误"},
  CTX_CALL_UNBOUND: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call is unavailable: nothing is bound for this module -- declare the address in \"countinghouse.calls\" (package.json) AND add the module's package.json name to some identity's \"runsModules\" in the auth config (sqlite: bind-module); both are required",
    zh: "ctx.call 不可用：该模块没有任何可用的组合绑定 -- 需要同时在 package.json 的 \"countinghouse.calls\" 中声明该地址，并在鉴权配置中把模块的 package.json name 加入某个身份的 \"runsModules\"（sqlite：bind-module），两者缺一不可"},
  CTX_CALL_UNDECLARED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: this address is not declared in the module's \"countinghouse.calls\" (package.json)",
    zh: "ctx.call 已拒绝：该地址未在模块的 \"countinghouse.calls\"（package.json）中声明"},
  CTX_CALL_BAD_ADDRESS: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: the address is malformed, expected <module>/<service>.<action>",
    zh: "ctx.call 已拒绝：地址格式错误，应为 <module>/<service>.<action>"},
  CTX_CALL_UNRESOLVED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: the address does not resolve against the target module's spec",
    zh: "ctx.call 已拒绝：该地址无法在目标模块的 spec 中解析到"},
  // RATE_LIMIT_EXCEEDED: HTTP: 429 from rate-limit-gate.js on HTTP; on MCP a tool error result
  RATE_LIMIT_EXCEEDED: {kind: 'caller', retryable: true, httpStatus: 429, mcpCode: null,
    en: "Rate limit exceeded: too many requests for this apiKey, retry shortly",
    zh: "超出速率限制：该 apiKey 的请求过于频繁，请稍后重试"},
  // the whole runtime at its server-wide limit (--globalRateLimit): the
  // runtime's, not the caller's, retried after Retry-After (#482's high, 1;
  // it was DENY_DEVICE_ACCESS, a denial blamed on the caller)
  RUNTIME_BUSY: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The runtime is at its request limit: retry shortly",
    zh: "运行时已达到请求上限，请稍后重试"},
  // TOOL_SCHEMA_RESOLVE_FAIL: kind/retryable: unsure, for review
  TOOL_SCHEMA_RESOLVE_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Tool schema resolution failed",
    zh: "工具 schema 解析失败"},
  MODULE_SANDBOX_REFUSED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Module refused by the module sandbox (enforce mode) -- run countinghouse-validate on it, fix the listed problems (permissions syntax, dependencies outside the module, native code), and load it again",
    zh: "模块被模块沙箱拒绝（enforce 模式）-- 请对其运行 countinghouse-validate，修复列出的问题（权限声明语法、模块目录之外的依赖、原生代码），然后重新加载"},
  MODULE_RESTARTING: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module's worker stopped (a resource limit or a crash) and is restarting -- retry after the time given; the server log has the reason",
    zh: "模块的 worker 已停止（资源限制或崩溃），正在重启 -- 请在给出的时间之后重试；原因见服务器日志"},
  MODULE_SUSPENDED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module was suspended after repeated worker exits -- an operator must fix the cause (see the server log) and restart it with POST /restart-module",
    zh: "模块因 worker 反复退出已被暂停 -- 需要运维人员排除原因（见服务器日志）后用 POST /restart-module 重启"},
  MODULE_RELOADING: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module is reloading and its worker was replaced while this was in progress -- retry; the new module answers once it has loaded",
    zh: "模块正在重新加载，处理过程中其 worker 已被替换 -- 请重试；新模块加载完成后即可应答"},
  // MODULE_UNLOADED: kind/retryable: unsure, for review
  MODULE_UNLOADED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module was unloaded (or its new code failed to load, or its worker ended with no supervisor to restart it) -- an operator must load it again",
    zh: "模块已被卸载（或新代码加载失败，或其 worker 退出且没有监督器重启它）-- 需要运维人员重新加载"},
  // RATE_LIMITED: kind/retryable: unsure, for review
  RATE_LIMITED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "This module sent too many messages to the main thread -- slow down, or ask the operator to raise --moduleMessageRate",
    zh: "该模块发往主线程的消息过多 -- 请降低频率，或请运维人员调高 --moduleMessageRate"},
  MODULE_NAME_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Not a valid npm package name -- give the module's package.json name (for example \"my-module\" or \"@scope/my-module\")",
    zh: "不是有效的 npm 包名 -- 请使用模块 package.json 中的名称（例如 \"my-module\" 或 \"@scope/my-module\"）"},
  // #164: an uninstall could not delete the module's ctx.redis keys (the
  // store did not answer); its data directory was kept, its registry entry
  // already removed.
  MODULE_KEYS_NOT_PURGED: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module's stored keys could not be deleted; its data directory was kept (its registry entry, if any, is already removed) -- try the uninstall again once the store answers",
    zh: "无法删除该模块保存的键；其数据目录已保留（如有注册表条目，已被删除）-- 请在存储恢复响应后重新卸载"},
  MODULE_LOADED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module is loaded, restarting or suspended -- unload it first (POST /unload-module), then uninstall it",
    zh: "模块已加载、正在重启或已被暂停 -- 请先卸载（POST /unload-module），再执行 uninstall"},
  MODULE_DATA_NOT_DIRECTORY: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module's data directory is not a real directory (a link or a file) -- it was left alone; remove it by hand under --moduleDataPath",
    zh: "模块的数据目录不是真正的目录（是链接或文件）-- 已保持原样；请在 --moduleDataPath 下手动删除"},
  MODULE_PATH_OUTSIDE_ROOT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "With --hardened, every module must live under --modulePath -- move the module there or load it from there",
    zh: "使用 --hardened 时，所有模块都必须位于 --modulePath 之下 -- 请把模块移到那里或从那里加载"},
  MODULE_NAME_MISMATCH: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "The load request names a module differently from its package.json -- load it under its package.json name",
    zh: "加载请求中的模块名与其 package.json 中的名称不一致 -- 请使用 package.json 中的名称加载"}
};

module.exports = {CODES: Object.freeze(Object.fromEntries(Object.entries(CODES).map(([k, v]) => [k, Object.freeze(v)])))};

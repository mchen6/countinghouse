// The error catalogue (docs/superpowers/specs/2026-11-09-logger-design.md §5.3): one table, code ->
// {kind, retryable, httpStatus, mcpCode, en}. It replaces the old error-info tables; the en
// texts are theirs, unchanged. Modules define their own codes and
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
    en: "Incorrect action type setting"},
  CANNOT_SET_ACTION_SERVICE_OBJ_NOT_EXIST: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot set action, service object does not exist, check whether the corresponding serviceID is defined in the API spec"},
  CANNOT_SET_ACTION_ACTION_LIST_NOT_EXIST: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot set action, actionList object does not exist, check whether an actionList object exists under the corresponding serviceID in the API spec"},
  CANNOT_SET_ACTION_OBJ_NOT_EXIST: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot set action, action does not exist, check whether this action is defined under the corresponding serviceID in the API spec"},
  CANNOT_SET_ACTION: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot set action"},
  NO_VALID_DEVICE_SPEC: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid device spec"},
  CANNOT_GET_DEVICE_SPEC: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot get device spec"},
  SERVICE_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Unknown service"},
  DEVICE_IN_ACTION: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Device is processing a call"},
  GET_HARDWARE_ADDR_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get device hardware address"},
  DEVICE_SPEC_UPDATE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device spec update failed"},
  DESTROY_DEVICE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to destroy device"},
  GET_DEVICE_SCHEMADOC_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get device schema document"},
  INVALID_DEVICE_SCHEMADOC: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid device schema document"},
  INVALID_JSON_POINTER: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid JSON pointer"},
  POINTER_DEREF_ERROR: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "JSON pointer dereference failed"},
  // a schema path the caller asked for that names nothing it may see (one
  // under a usable action that isn't there, or under an unusable one: one
  // answer); POINTER_DEREF_ERROR stays the module's document failing
  SCHEMA_PATH_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Nothing is at this schema path"},
  PROXY_SERVER_CREATE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to create reverse proxy server"},
  DEVICE_CONNECT_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device connect failed"},
  INVALID_REDIRECT_URL: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid redirect URL"},
  DEVICE_DISCONNECT_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device disconnect failed"},
  // DEVICE_NOT_CONNECTED: kind/retryable: unsure, for review
  DEVICE_NOT_CONNECTED: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Device not connected"},
  DEVICE_SPEC_VALIDATION_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device spec validation failed"},
  INVALID_MODULE_INSTANCE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid device module instance"},
  // DEVICE_OBJECT_CONFLICT: kind/retryable: unsure, for review
  DEVICE_OBJECT_CONFLICT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device object conflict"},
  // DEVICE_OFFLINE: kind/retryable: unsure, for review
  DEVICE_OFFLINE: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Device is offline"},
  MODULE_VERIFICATION_FAILED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device module verification failed"},
  // DEVICE_NOT_FOUND: kind/retryable: unsure, for review
  DEVICE_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Device not found"},
  DEVICE_ACTION_CALL_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to call device action"},
  DEVICE_OBJECT_NOT_VALID_CDIF_DEVICE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device object is not a valid CDIF device"},
  // CORRESPONDING_MODULE_NOT_FOUND: kind/retryable: unsure, for review
  CORRESPONDING_MODULE_NOT_FOUND: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Corresponding device module not found"},
  LOAD_MODULE_FAIL: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Module load failed"},
  // #144: the worker did not answer its load within --moduleLoadTimeout (a
  // module that blocks while it is required) and was ended.
  MODULE_LOAD_TIMEOUT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module did not finish loading within --moduleLoadTimeout; its worker was ended -- check that nothing it requires blocks"},
  // MODULE_LOAD_SUPERSEDED: kind/retryable: unsure, for review
  MODULE_LOAD_SUPERSEDED: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A later load, reload or unload of this module took over; this one did nothing"},
  GET_MODULE_INFO_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get module info"},
  REMOVE_MODULE_INFO_FAIL: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to remove the module's registry entry -- its data directory was kept; its stored data was deleted unless the uninstall was asked to keep it; uninstall again to finish; the server log has the reason"},
  MODULE_PACKAGE_INFO_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid module package info file"},
  MODULE_PACKAGE_NAME_TYPE_ERROR: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Module package name type error"},
  MODULE_VERSION_INFO_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Invalid module version info"},
  INVALID_MODULE_PATH: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid module path name"},
  SCHEMA_COMPILE_ERROR: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Schema compile error"},
  SERVICEID_NOT_AVAILABLE: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "serviceID not found"},
  ACTIONNAME_NOT_AVAILABLE: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "actionName not found"},
  ARGUMENTS_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid call arguments"},
  MISSING_OUTPUT_ARGUMENT: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Missing output field in the output data"},
  INPUT_DATA_VALIDATION_FAIL: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Input data validation error"},
  OUTPUT_DATA_VALIDATION_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Output data validation error"},
  ACTION_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Action not found"},
  INPUT_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Input object not found"},
  ACTION_NOT_IMPLEMENTED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Action not implemented"},
  DEVICE_INVOKE_EXCEPTION: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device interface call threw an exception"},
  // DEVICE_INVOKE_FAIL: kind/retryable: unsure, for review
  DEVICE_INVOKE_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device call failed"},
  // DEVICE_ACCESS_ERROR: kind/retryable: unsure, for review
  DEVICE_ACCESS_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device access failed"},
  DEVICE_NOT_RESPONDING: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Device is not responding"},
  // REDIS_CLIENT_ERROR: kind/retryable: unsure, for review
  REDIS_CLIENT_ERROR: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Redis client error"},
  SYSTEM_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "System error"},
  // SYSTEM_ERROR_USERDB_NA: kind/retryable: unsure, for review
  // SYSTEM_ERROR_USERDB_NA: HTTP: this row's status on every route (lib/countinghouse-error.js answerError, post-rel caller 400); MCP: JSON-RPC -32603 without the code on tools/call, plain or task-augmented (gateway.js userAuth), and on tasks/* (resolveGatedIdentity); a tool error result only from countinghouse_check_balance (pinned by test/mcp-contract/07)
  SYSTEM_ERROR_USERDB_NA: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "User database unavailable"},
  // SYSTEM_ERROR_UNKNOWN_USER: HTTP: 401 on every route, with WWW-Authenticate (answerError, post-rel caller 400); MCP: JSON-RPC -32603 without the code on tools/call, plain or task-augmented (gateway.js userAuth), and on tasks/* (resolveGatedIdentity); a tool error result only from countinghouse_check_balance (pinned by test/mcp-contract/07)
  SYSTEM_ERROR_UNKNOWN_USER: {kind: 'caller', retryable: false, httpStatus: 401, mcpCode: null,
    en: "Unknown user"},
  // USER_HAS_NO_DEVICE: HTTP: on a device route answered as one not there or not listed, MODULE_NOT_LISTED 404 (routes/user.js, post-rel caller 400), elsewhere this row's 403; MCP: on tools/call, plain or task-augmented, a known key's tool outside its grants answers -32602 "unknown tool" (gateway.js handleToolsCall), and this only from userAuth's second gate within a grant set's 5 s; -32603 without the code on tasks/* (resolveGatedIdentity); a tool error result only from countinghouse_check_balance (pinned by test/mcp-contract/07)
  USER_HAS_NO_DEVICE: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "This apiKey does not have access to this device: ask the operator to add it to the apiKey's devices list in the auth config"},
  // ADMIN_REQUIRED: HTTP: 403 (routes/admin-only.js); on MCP none: an authoring tool for a key that is no admin's is an unknown tool, as it is not listed to it (#458)
  ADMIN_REQUIRED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "This operation requires an admin apiKey"},
  AUTH_RELOAD_INVALID: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The auth configuration was not reloaded, because it failed its checks -- the configuration in use is unchanged; fix the problem named and reload again"},
  // IDENTITY_NOT_FOUND: /identity-lookup and countinghouse_lookup_identity (lib/identity.js), admin only
  IDENTITY_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "No user has this id on this server"},
  RESTART_MODULE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to restart module"},
  UNLOAD_MODULE_FAIL: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to unload module"},
  ADD_JOB_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to add job"},
  GET_JOB_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get job info"},
  REMOVE_JOB_ERROR: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to remove job"},
  DEVICE_CONFIG_LOAD_FAIL: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Failed to get app config info"},
  DEVICE_ID_INVALID_OR_NULL: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Invalid device ID"},
  PEER_GONE: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Direct peer channel is no longer valid"},
  // PEER_NOT_GRANTED: kind/retryable: unsure, for review
  PEER_NOT_GRANTED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Refused: this direct peer channel was not granted for that device"},
  PEER_CHANNEL_TIMEOUT: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Direct peer channel call timed out"},
  PEER_SELF_TARGET: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Target device is hosted by the requesting worker itself, direct peer channel not applicable"},
  PEER_NO_HANDLER: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "No peer-invoke handler registered on the remote side"},
  // Step 3c: a hop stated a usageCall its worker was not dispatched (a
  // module forging another caller's call id). The hop is not forwarded.
  USAGE_CALL_FOREIGN: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: 'A hop stated a usage call its worker was not given'},
  // Local-mode spec §5: `receipt` at the top of a tool's output is the
  // runtime's (the receipt of what the call read and returned).
  RECEIPT_RESERVED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A tool's output may not have a top-level field named receipt: the runtime adds the receipt"},
  // A module the caller's listing does not show: a part another module calls
  // (local-mode spec §3), a non-scenario module under the single-identity
  // profile, one going on or off (#413 rev 3, section 5.5), or, over HTTP's
  // spec and schema routes, any of these (#447). Worded to be true for every
  // reason, for a user who set no key (the reviewer, 2026-11-19).
  MODULE_NOT_LISTED: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "This tool is not available to this caller here"},
  // A module whose part (named in countinghouse.calls) is not installed or
  // not available (M6: #413 rev 3 section 11, a module, never a pack).
  PART_MISSING: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A module this one calls is not installed or not available, so it was not loaded"},
  // A module's bare tool name is already a listed tool's or a built-in's.
  TOOL_NAME_TAKEN: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A module's tool name is already taken by another tool, so the module was not loaded"},
  // The same for a prompt's name (the reviewer's #340 review, 3): a clash is
  // refused at load, never renamed at listing.
  PROMPT_NAME_TAKEN: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A module's prompt name is already taken by another prompt, so the module was not loaded"},
  // Two scenarios need one module at two versions (packs in place, part 2): a
  // runtime holds one version of a module.
  PART_VERSION_CONFLICT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{name} is needed at {versions}; a runtime holds one version of a module, so {scenario} was not loaded"},
  MODULE_NO_DEVICE_ONLINE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Device module produced no usable device"},
  QUERY_DEVICE_ON_MAIN_THREAD: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Cannot look up a device from the main thread in worker-thread mode"},
  // one answer for a job the caller can't see: none with that id, or one
  // another key owns (get-job, remove-job; post-rel caller 400: no probing
  // which jobs exist)
  JOB_NOT_FOUND: {kind: 'caller', retryable: false, httpStatus: 404, mcpCode: null,
    en: "Job not found"},
  // a job request the caller got wrong (no opts, no name, a bound
  // exceeded, a remove with no isRepeat flag): the caller's, 400 (post-rel
  // caller 400's medium, 7); ADD_JOB_ERROR and REMOVE_JOB_ERROR stay for
  // the runtime's own failures
  JOB_OPTS_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "The job request is not valid"},
  MODULE_ASSEMBLY_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Handler-map module assembly failed"},
  // A module answered with a code of this catalogue (ctx.error's code, or
  // one set on its error after): a module defines only its own codes (the
  // logger spec, section 12, 1), so its error never passes for the
  // runtime's. {code}: that code's name, nothing else of the module's.
  MODULE_CODE_RESERVED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: 'the module answered with the runtime\'s own code {code}, which a module may not use'},
  MODULE_HANDLER_MISMATCH: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Handler map does not match api.json"},
  // R2-1 Task 3 (lib/call-tokens.js): a worker's hop, device query, remote
  // call or peer announcement cited a per-call token the main thread did not
  // issue, that has expired, or that was issued to another worker.
  CALL_TOKEN_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Refused: the call's token is unknown, expired or not this worker's, so the hop cannot be billed or authorized"},
  // HOP_CHAIN_TOO_DEEP (R2-1 Task 3, the review of #141): a hop whose call
  // chain is already MAX_CHAIN_DEPTH deep (lib/call-tokens.js); mutual
  // recursion between composites is what reaches it.
  HOP_CHAIN_TOO_DEEP: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Refused: the call chain is too deep (a hop inside a hop, past the limit); composites must not call each other without end"},
  // Lean worker step 1(b) (lib/validator-pool.js; the reviewer's texts,
  // 2026-11-13). Fields: {module}, {action}, {which} (input or
  // output), {ms}; never a key or a value.
  VALIDATION_TIMEOUT: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its {which} was not validated within {ms} ms, so the call was refused"},
  // A hop's input over --maxOutputBytes (the one cap; the reviewer's ruling
  // and texts, 2026-11-14): refused on the main thread from the bytes'
  // length, before any validator or the callee sees it. {module}/{action}:
  // the called action. A module's own hop, never the HTTP client's request:
  // 500, as OUTPUT_TOO_LARGE. Fields: {module}, {action}, {bytes}, {max}.
  INPUT_TOO_LARGE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its input is {bytes} bytes, over the {max}-byte limit (--maxOutputBytes), so the call was refused. To allow more: {raise}"},
  // A module's reply over --maxOutputBytes, measured in its own worker before
  // it is posted (lib/lean-worker.js). Fields: {module}, {action}, {bytes},
  // {max}; the reviewer's texts, 2026-11-13.
  // #170: a message from a module's worker to the main thread over the cap
  // (--maxOutputBytes plus 64 KiB), refused in the worker before it is posted.
  MESSAGE_TOO_LARGE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "A message from the module to the runtime was larger than allowed -- send less at once"},
  OUTPUT_TOO_LARGE: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its output is {bytes} bytes, over the {max}-byte limit (--maxOutputBytes), so the call was refused. To allow more: {raise}"},
  // A module's output holding a Buffer, a typed array or a DataView, which
  // is not JSON (MCP completeness, spec section 1; lib/serialized-result.js
  // serializeOutput, in the module's worker). Fields: {module}, {action},
  // {field} (a JSON pointer into the output).
  OUTPUT_NOT_JSON: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its output holds a Buffer, typed array or DataView at {field}, which is not JSON, so the call was refused: return buf.toString('base64') in a field its output schema declares contentEncoding: base64."},
  // The result store (MCP completeness M5, lib/store/blobs.js) has no room
  // for a value that would be stored and linked: nothing is evicted early,
  // since a link promises its retention. Fields: {limit}, the option whose
  // limit was reached: maxOutputBytes (one value over three quarters of it),
  // resourceQuotaBytes, resourceQuotaItems or resourceStoreBytes.
  // A result with a binary value that must be stored (M6: a resource type,
  // or past --inlineContentBytes) from a call with no caller to own it (a
  // debug call with no key).
  RESULT_NOT_STORABLE: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: 'this result has a binary value that must be stored and read back, and the call has no caller to store it for; call with an API key'},
  RESULT_STORE_FULL: {kind: 'runtime', retryable: true, httpStatus: 507, mcpCode: null,
    en: "the result store has no room for this result's stored value ({limit}), so the call's result was not stored; stored results expire with --resourceRetention, or the operator can raise --{limit}."},
  // The result store (--store redis) did not answer a stored result's write
  // or read within its deadline, or Redis is down (the back-sweep, 11-18:
  // #16's rule, calls answer with Redis down, for results with a binary
  // value). Nothing was stored; the call can be made again.
  RESULT_STORE_UNAVAILABLE: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: 'the result store did not answer in time, so this result\'s binary value was not stored; try the call again'},
  // A result holding more binary values than one answer may carry (MCP
  // completeness, spec section 1; lib/binary-fields.js): an array counts each
  // item. Fields: {module}, {action}, {max}.
  TOO_MANY_BINARY_VALUES: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}/{action}: its result holds more than {max} binary values (fields declared contentEncoding: base64, an array counting each item), so the call was refused."},
  // An input's stalls are held against its caller (the review of #165): only
  // that caller's calls to the module are refused, for a while.
  VALIDATION_CALLER_THROTTLED: {kind: 'module', retryable: true, httpStatus: 429, mcpCode: null,
    en: "{module}/{action}: this caller's inputs to the module kept missing the validation deadline ({stalls} in {minutes} minutes), so its calls to the module are refused for {seconds} s"},
  // countinghouse_settings (packs in place, part 2; spec #168 section 3).
  // Fields: {name}, {value}, {bounds};
  // {problem} for a file that cannot be used.
  SETTING_UNKNOWN: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "There is no setting named {name}; the settings that can be changed are in get's answer."},
  SETTING_OUT_OF_BOUNDS: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "The value {value} for {name} is outside the allowed range ({bounds}); nothing was changed."},
  SETTING_LOOSENS_A_GUARD: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Changing {name} to {value} would loosen a guarding setting, which can only be done from a terminal; nothing was changed. To change it, run `{command}` in a terminal yourself."},
  // Part 3 (guarding settings by conversation): a loosening conversation may
  // ask for, not confirmed by the user; addressed to the user, not the agent.
  SETTING_NEEDS_CONFIRMATION: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Changing {name} to {value} loosens a guarding setting, so it needs your own confirmation; nothing was changed. To allow this, run `{command}` in a terminal yourself. That change is kept, not just for this session, and a value above what this runtime started with takes effect when it next starts."},
  // The authoring tools in the single-identity profile, for the user's own
  // modules (B-own-runtime): a folder validation won't read, and a load
  // that is the user's own act in their own terminal; addressed to the user.
  OWN_MODULE_PATH_REFUSED: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Your module's folder can't be checked here: {reason}."},
  OWN_MODULE_NEEDS_TERMINAL: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loading your own module needs your confirmation: run `{command}` in your own terminal."},
  // The shared runtime: a change a session may not make there (a setting that
  // isn't a session's or a module's, or past its recorded changes); the
  // terminal does.
  SETTING_TERMINAL_ONLY_SHARED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "This shared runtime takes this change to {name} from a terminal only; nothing was changed. To change {name} for all sessions, run `{command}` in a terminal yourself."},
  // Part 3, section 4: the operator's ceiling (lib/settings-ceiling.js).
  SETTING_ABOVE_CEILING: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "{name} {value} is above the ceiling this machine's operator set ({ceiling}); nothing was changed."},
  SETTING_FORBIDDEN_BY_CEILING: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "{name} cannot be changed to {value} on this machine: its operator's ceiling forbids it; nothing was changed."},
  SETTING_CEILING_UNTRUSTED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "The operator's ceiling file {file} cannot be trusted ({problem}), so no setting is loosened; nothing was changed."},
  // M5b (#449's high review, 5; round 4, 8): a module turned on, or a name not
  // loaded turned off, while ch-local's record of the installed modules
  // (modules.json) cannot be read: said as it is
  SETTING_RECORD_UNREADABLE: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "ch-local's record of the installed modules can't be read right now, so {name} can't be changed here; nothing was changed. Try again in a moment, or run `{command}` in a terminal yourself."},
  // Part 3, section 2: a loosening confirmed in the client's dialog
  // (lib/settings-confirm.js, lib/settings-tool.js confirm).
  // A module's question (ctx.ask; the MCP completeness design, section 8).
  // ASK_PENDING ends the handler's first pass: the call is answered with the
  // question (input_required) and the handler runs again, from the top, on
  // the client's retry. ASK_UNAVAILABLE is one a module may catch to fall
  // back. ASK_NOT_DECLARED is the module's own mistake.
  ASK_PENDING: {kind: 'runtime', retryable: false, httpStatus: 409, mcpCode: null,
    en: "A question for the user is pending: the call is answered with it, and runs again from the top once the user has answered. Let this error pass."},
  ASK_UNAVAILABLE: {kind: 'runtime', retryable: false, httpStatus: 409, mcpCode: null,
    en: "No one can be asked here: the client offered no form, the call did not come from an MCP client that can answer one, it runs as a task whose client offered no form or with too many tasks already waiting on questions, module questions are turned off, or no valid answer came in three rounds."},
  // A task's question waited past its time (M22, lib/task-asks.js): the
  // task fails with it, and nothing runs again.
  ASK_EXPIRED: {kind: 'runtime', retryable: false, httpStatus: 410, mcpCode: null,
    en: "The task's question was not answered in time: the task has stopped, and nothing more of it will run. Call the tool again to start over."},
  // A retry's requestState (lib/request-state.js): not this call's, expired
  // or already used. One answer, whatever failed: a caller learns nothing
  // of which. ASK_STATE_UNCHECKED is not that: the store could not say
  // whether the state was used, and nothing ran. The same retry may be sent
  // again, but a store that timed out may still have recorded the state as
  // used: the retry is then refused, and the caller asks again.
  ASK_STATE_INVALID: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "That answer cannot be taken for this call: its state is not one this runtime gave for this call, has expired, or was already used. Call the tool again without it."},
  ASK_STATE_UNCHECKED: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The answer could not be checked just now: the store did not say whether its state was used. Nothing ran. The answer may no longer be usable: send the same retry once, and if it is refused, call the tool again without it to be asked again."},
  ASK_NOT_DECLARED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "This action declares no such question, or a value for one of its placeholders is missing or is not a string, a number or a boolean"},
  SETTING_CONFIRMATION_INVALID: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "That confirmation is not one this runtime gave for this change, or it was replaced by a newer request; nothing was changed. Ask again for a new one."},
  SETTING_CONFIRMATION_EXPIRED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "That confirmation has expired (it lasts 120 seconds); nothing was changed."},
  SETTING_CONFIRMATION_USED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "That confirmation was already used; nothing more was changed."},
  SETTING_DECLINED_THIS_START: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loosening {name} was declined, or left unanswered, in this session, so it is not asked again until countinghouse restarts; nothing was changed. To allow it, run `{command}` in a terminal yourself."},
  // A shared runtime's session (B2 Task 5): its lock lasts the session's
  // life, and it falls on a decline or on two forms left unanswered. A kind
  // the latch locked (its client could answer a form by itself) is
  // SETTING_CLIENT_NOT_CONFIRMED, below, unless the tested list, read whole, has
  // no client; with none, the answer every session gets (SETTING_NEEDS_CONFIRMATION).
  // A session's own lowering that cannot be undone in conversation now (a
  // kind the user locked, or may have, in the session or across the user's
  // sessions, or the ceiling turning conversation off; a latch alone never
  // holds it in the runtime it fell in, and a lock kept across a restart, which
  // may be the user's, does unless the tested list, read whole, has no client):
  // a terminal change sets the value for all sessions, which never moves a
  // session's own lower value, so no command is named; a new session (the
  // client restarted) runs at the value for all sessions. (A runtime
  // restart replays the session's own value: not a way back.)
  SETTING_SESSION_OWN_VALUE_HELD: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "This session set {name} to {current} itself, and it cannot be raised back in conversation now ({why}); nothing was changed. A change in a terminal would not move it: it sets the value for all sessions ({value}), and this session keeps its own lower value. It ends with this session: restart your client, and its new session runs at {value}."},
  SETTING_DECLINED_THIS_SESSION: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loosening {name} is not asked again in this session (it was declined or left unanswered here); nothing was changed. To allow it, run `{command}` in a terminal yourself."},
  // A session's lock restored across a runtime restart: whether it was a
  // decline or a latch before it is not known here, so it says neither
  // (the reviewer's ruling (c) on #337).
  SETTING_LOCKED_THIS_SESSION: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loosening {name} is not available to change in this session; nothing was changed. To allow it, run `{command}` in a terminal yourself."},
  // A session whose client said its configuration could answer a form by
  // itself (the latch, N1): never asked in it, and never said to be a
  // decline. {why} is lib/conditions-why.js's sentence.
  SETTING_CLIENT_NOT_CONFIRMED: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "Loosening {name} is not asked in this session: {why}; nothing was changed. To allow it, run `{command}` in a terminal yourself."},
  SETTING_CHANGED_MEANWHILE: {kind: 'caller', retryable: false, httpStatus: 409, mcpCode: null,
    en: "{name} was changed while you were asked, so the confirmed change was not applied; nothing was changed."},
  SETTING_CEILING_CHANGED_MEANWHILE: {kind: 'caller', retryable: true, httpStatus: 409, mcpCode: null,
    en: "This machine's operator ceiling changed while you were asked about {name}, so the confirmed change was not applied; nothing was changed. Ask again to see it under the ceiling now in force."},
  SETTING_NOT_APPLIED: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The change to {name} for this start could not be applied ({problem}); nothing was changed."},
  // the same for a shared runtime's session, whose change was its own
  SETTING_NOT_APPLIED_THIS_SESSION: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The change to {name} for this session could not be applied ({problem}); nothing was changed."},
  // and for a change one session confirmed for all sessions (B2 Task 5b)
  SETTING_NOT_APPLIED_ALL_SESSIONS: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The change to {name} for all sessions could not be applied ({problem}); nothing was changed."},
  SETTINGS_BUSY: {kind: 'caller', retryable: true, httpStatus: 409, mcpCode: null,
    en: "Another change to the settings is under way; nothing was changed. Try again in a moment."},
  SETTINGS_FILE_INVALID: {kind: 'caller', retryable: false, httpStatus: 409, mcpCode: null,
    en: "The settings file cannot be used ({problem}); nothing was changed. The user can fix it, or reset it with `{command}` in a terminal."},
  SETTING_NOT_RECORDED: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "The change could not be recorded in the settings history; nothing was changed."},
  VALIDATION_QUARANTINED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}: its calls are refused after repeated validation timeouts, until the module is reloaded"},
  // One module format (lean worker, step 1; reviewer's texts, 2026-11-13). Fields, filled in by
  // CountinghouseError.withFields (lib/module-layout.js raises it): {name}, the module's name; {file},
  // what makes its main entry (package.json "main": "device.js", or index.js).
  // R1 (shared-runtime design #236, section 4a): a module's state
  // declaration, countinghouse.state in its package.json (lib/module-state.js)
  MODULE_STATE_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}: countinghouse.state is {value}; it must be \"shared\" or \"per-session\", so the module was not loaded"},
  SETTING_REQUIRED: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "{module} needs a setting: {settings}. {hint}"},
  // A module's setting changed in conversation (the module-level
  // configuration design, section 4.4; lib/settings-tool.js): a hint names
  // the setting and never carries a value.
  SETTING_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "{name} was not changed: {reason}."},
  SETTING_MODULE_NEEDS_CONFIRMATION: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "This change to {name} needs your own confirmation; nothing was changed. To make it, run `{command}` at a terminal yourself."},
  SETTING_FIXED_BY_CEILING: {kind: 'caller', retryable: false, httpStatus: 403, mcpCode: null,
    en: "{name} is fixed by this machine's operator (its ceiling); nothing was changed."},
  SETTING_CURSOR_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "That cursor is not one get gave; call get without a cursor to start again."},
  // #449's high review, round 3, 6: the rows a cursor was cut from changed
  // (a module installed, removed, loaded or unloaded meanwhile)
  SETTING_CURSOR_STALE: {kind: 'caller', retryable: false, httpStatus: 409, mcpCode: null,
    en: "The list of settings changed since that page was given, so nothing after it is shown; call get without a cursor to start again."},
  // a module that declares settings, called before its settings state is
  // there (lib/settings-gate.js): nothing run
  SETTING_NOT_READY: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The settings of {module} are not ready yet; nothing was run. Try again in a moment."},
  // module settings run only with worker threads (the user's decision,
  // 11-18; lib/module-manager.js)
  SETTINGS_NEED_WORKER_THREADS: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module} declares settings, which run only with worker threads (--workerThread); this version was not loaded (a version already loaded keeps serving)."},
  SETTINGS_DECLARATION_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}: its settings declaration (countinghouse.settings) is invalid: {problem}, so the module was not loaded"},
  MODULE_NEEDS_SESSIONS: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module} keeps state per session, which needs the shared runtime's sessions; it can't be loaded on the HTTP hosting profile"},
  MODULE_STATE_CHANGED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{module}: countinghouse.state changed from {from} to {to}; a loaded module's state can't change in place, so unload it first, then load it"},
  // R1: a per-session module's worker for one session, ended under a call
  // (a crash or a limit): that session's next call starts a fresh one.
  SESSION_WORKER_ENDED: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module's worker for this session ended (a resource limit or a crash) while this was in progress. Retry: this session's next call starts a fresh worker, whose in-memory state starts empty; the server log has the reason"},
  // R1: a per-session module's worker for one session that could not start
  // (its partition could not be made, its worker failed to load). Its own
  // error is logged: it can name the session and a path, and this text goes
  // to a calling module or a job's history.
  SESSION_WORKER_NOT_STARTED: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module's worker for this session could not start; the server log has the reason"},
  // R1: the supervisor's rule for one (module, session): {module}, {minutes}
  // (its window). Other sessions run on.
  MODULE_SESSION_PAUSED: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "{module}'s worker for this session stopped repeatedly, so it is paused for this session; it starts again after {minutes} minutes, or once the module is reloaded. Other sessions are not affected; the server log has the reason"},
  // {max}: --maxSessionWorkers. Retryable: a slot frees when a call ends.
  SESSION_WORKERS_BUSY: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "All {max} per-session module workers are busy with calls, so none could be started for this one; retry shortly"},
  // {name}: the module (its directory's name when its package.json can't be
  // read for one). The high review of #452.
  MODULE_PACKAGE_BOM: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{name}: package.json starts with a byte-order mark; save it without one"},
  MODULE_LAYOUT_UNSUPPORTED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "{name}: a module is api.json, schema.json and handlers/<service>/<action>.js; this one has {file} and no handlers/ directory. See docs/module-development.md."},
  // HOP_IDENTITY_UNRESOLVED: kind/retryable: unsure, for review
  HOP_IDENTITY_UNRESOLVED: {kind: 'runtime', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Refused: the calling identity for this inner hop could not be resolved, so the call cannot be billed to anyone"},
  MODULE_COMPOSITION_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Module composition declaration is invalid"},
  // RC1-min (lib/remote/, docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md): the module's own
  // declaration, credential setup or call.
  REMOTE_DECLARATION_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module's remote MCP server declaration (countinghouse.remotes) is invalid"},
  REMOTE_CREDENTIAL_NOT_ALLOWED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The remote's credential is not allowed for its origin by the operator's --remoteCredentials file; the remote is disabled"},
  REMOTE_CREDENTIAL_MISSING: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The remote's credential variable is allowed but was not set when the module loaded"},
  REMOTE_UNDECLARED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: the module declares no such remote in \"countinghouse.remotes\" (package.json)"},
  REMOTE_ARGS_INVALID: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: a remote call takes the address remote:<name>/<tool> and a plain JSON object of arguments"},
  // RC1-min (lib/remote/client.js, docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md section 4):
  // a module's remote MCP server failed in transport or protocol. A tool's
  // own error (isError) is a result, never one of these.
  REMOTE_UNREACHABLE: {kind: 'runtime', retryable: true, httpStatus: 502, mcpCode: null,
    en: "The remote MCP server could not be reached (DNS, connection or TLS failure, or a redirect to another origin, which is refused)"},
  // JOB_TIMEOUT: a job's run past its own timeout, else --jobTimeout (both
  // runners, lib/job-control-common.js timeoutError): stored as its
  // failedReason, "JOB_TIMEOUT: <text>", so a task's failure carries the code
  JOB_TIMEOUT: {kind: 'runtime', retryable: true, httpStatus: 504, mcpCode: null,
    en: "The job did not finish within its timeout ({seconds} s), so it failed; an answer after that is dropped"},
  REMOTE_TIMEOUT: {kind: 'runtime', retryable: true, httpStatus: 504, mcpCode: null,
    en: "The remote MCP server did not answer within --remoteTimeout"},
  REMOTE_AUTH_FAILED: {kind: 'runtime', retryable: false, httpStatus: 502, mcpCode: null,
    en: "The remote MCP server refused the credential (401 or 403)"},
  REMOTE_PROTOCOL: {kind: 'runtime', retryable: false, httpStatus: 502, mcpCode: null,
    en: "The remote MCP server's answer is not a valid MCP response"},
  REMOTE_RESULT_TOO_LARGE: {kind: 'runtime', retryable: false, httpStatus: 502, mcpCode: null,
    en: "The remote MCP server's answer is over --remoteMaxBytes"},
  REMOTE_ADDRESS_REFUSED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The remote's host resolves to a loopback, private or Redis-endpoint address, which is refused"},
  CTX_CALL_NOT_READY: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "Not ready yet: the runtime is still checking a module this call needs, so the call to it was not run; retry in a few seconds."},
  CTX_CALL_UNBOUND: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call is unavailable: nothing is bound for this module -- declare the address in \"countinghouse.calls\" (package.json) AND add the module's package.json name to some identity's \"runsModules\" in the auth config (sqlite: bind-module); both are required"},
  CTX_CALL_UNDECLARED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: this address is not declared in the module's \"countinghouse.calls\" (package.json)"},
  CTX_CALL_BAD_ADDRESS: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: the address is malformed, expected <module>/<service>.<action>"},
  CTX_CALL_UNRESOLVED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "ctx.call refused: the address does not resolve against the target module's spec"},
  // UNAUTH_RATE_LIMITED: lib/unauth-limit.js, before any route, the same for
  // every key that doesn't resolve and every route or tool named; its retry
  // hint is the limiter's (countinghouse-error setRetryAfter), as every
  // limiter's (#482, merging #483)
  UNAUTH_RATE_LIMITED: {kind: 'caller', retryable: true, httpStatus: 429, mcpCode: null,
    en: 'Too many requests from this address with an API key that does not resolve; retry after the time Retry-After gives'},
  // RATE_LIMIT_EXCEEDED: HTTP: 429 from rate-limit-gate.js; on /mcp a tool error result for
  // tools/call, elsewhere the JSON-RPC error -32000, sent as 429 with Retry-After (A-rpc429)
  RATE_LIMIT_EXCEEDED: {kind: 'caller', retryable: true, httpStatus: 429, mcpCode: null,
    en: "Rate limit exceeded: too many requests for this apiKey, retry shortly"},
  // TOO_MANY_SUBSCRIPTIONS: subscriptions/listen with as many open as one
  // key (8) or one session (2) may have: the caller's, retried once one of
  // its own closes (lib/mcp/subscriptions.js); answered as every limit on
  // /mcp (#494's high, 1). The runtime's own total is SUBSCRIPTIONS_FULL.
  TOO_MANY_SUBSCRIPTIONS: {kind: 'caller', retryable: true, httpStatus: 429, mcpCode: null,
    en: 'Too many subscriptions are open for this key or session: close one, then retry'},
  // SUBSCRIPTIONS_FULL: subscriptions/listen with as many open on the whole
  // runtime as it holds (lib/mcp/subscriptions.js maxTotal): the runtime's,
  // retried once one closes; not its request limit (RUNTIME_BUSY)
  SUBSCRIPTIONS_FULL: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: 'The runtime has as many subscriptions open as it allows; retry once one closes'},
  // the whole runtime at its server-wide limit (--globalRateLimit): the
  // runtime's, not the caller's, retried after Retry-After (#482's high, 1;
  // it was DENY_DEVICE_ACCESS, a denial blamed on the caller)
  RUNTIME_BUSY: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The runtime is at its request limit: retry shortly"},
  // a local usage ledger (metering.json) that can't be used (R-store-aside-locked;
  // business's words, 11-27): corrupt, and this runtime never saw it whole, so
  // it holds no copy and nothing repairs it but a person (its log says how);
  // the same from the per-key gate and from a balance asked for
  LEDGER_CORRUPT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The usage ledger can't be read, so charged calls and balance checks are refused until it is repaired; the runtime's log says how"},
  // the same ledger unreadable for now (its last read failed; a corrupt one
  // this runtime saw whole is not refused, its map replaces it): retried
  LEDGER_UNREADABLE: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The usage ledger can't be read right now; charged calls and balance checks are refused until it can be read again"},
  // A billed call refused because its charge can't be recorded now (the
  // owner's decision, 11-27: a billed call runs only while its charge can be
  // recorded): the Redis ledger can't be reached, or answered a charge with
  // an error (lib/metering/charge-mark.js); the local ledger's last write
  // failed. "retry shortly" in the text: an agent reading a tool's answer
  // sees no Retry-After, and over stdio there is none.
  LEDGER_UNREACHABLE: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The usage ledger can't be reached right now; charged calls and balance checks are refused until it can be reached again: retry shortly"},
  // One key's own usage record can't be charged (of the wrong type, or its
  // free-call record isn't JSON): it stays so until someone repairs it, so
  // not retryable; that key's charged calls are refused meanwhile; the log
  // names the record by the key's fingerprint. Business's words.
  LEDGER_RECORD_INVALID: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "This key's usage record can't be read, so its charged calls are refused until the operator repairs it; the runtime's log names the record"},
  LEDGER_UNWRITABLE: {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
    en: "The usage ledger can't be written right now; charged calls are refused until a write succeeds again: retry shortly"},
  // TOOL_SCHEMA_RESOLVE_FAIL: kind/retryable: unsure, for review
  TOOL_SCHEMA_RESOLVE_FAIL: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Tool schema resolution failed"},
  MODULE_SANDBOX_REFUSED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "Module refused by the module sandbox (enforce mode) -- run countinghouse-validate on it, fix the listed problems (permissions syntax, dependencies outside the module, native code), and load it again"},
  MODULE_RESTARTING: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module's worker stopped (a resource limit or a crash) and is restarting -- retry after the time given; the server log has the reason"},
  MODULE_SUSPENDED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module was suspended after repeated worker exits -- an operator must fix the cause (see the server log) and restart it with POST /restart-module"},
  MODULE_RELOADING: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module is reloading and its worker was replaced while this was in progress -- retry; the new module answers once it has loaded"},
  // MODULE_UNLOADED: kind/retryable: unsure, for review
  MODULE_UNLOADED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module was unloaded (or its new code failed to load, or its worker ended with no supervisor to restart it) -- an operator must load it again"},
  // RATE_LIMITED: kind/retryable: unsure, for review
  RATE_LIMITED: {kind: 'module', retryable: false, httpStatus: 500, mcpCode: null,
    en: "This module sent too many messages to the main thread -- slow down, or ask the operator to raise --moduleMessageRate"},
  MODULE_NAME_INVALID: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "Not a valid npm package name -- give the module's package.json name (for example \"my-module\" or \"@scope/my-module\")"},
  // an uninstall refused before anything is touched: the local kv.json is
  // corrupt and this runtime never saw it whole, so the module's keys can't
  // be purged; nothing was removed, and a retry can't succeed until the
  // store is repaired (R-store-aside-locked; business's words, 11-27)
  MODULE_STORE_CORRUPT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module was not uninstalled: the store file that holds its data is corrupt, and this runtime holds no copy of it, so nothing was removed -- repair the store (the runtime's log says how), then uninstall again"},
  // #164: an uninstall could not delete all of the module's ctx.redis keys
  // (the store did not answer, or answered an error); they go first, so the
  // registry entry and the data directory are kept, though some keys may
  // already be gone; a retry deletes what is left. {code}: the store's error
  // code alone.
  MODULE_KEYS_NOT_PURGED: {kind: 'runtime', retryable: true, httpStatus: 500, mcpCode: null,
    en: "The module's stored data could not all be deleted ({code}): its registry entry and data directory are kept, and some of its stored data may already be deleted -- try the uninstall again: it deletes what is left"},
  // An uninstall's directory step failed after the keys and the registry
  // row were gone (a marker write on a full or read-only disk, a session
  // partition's removal, a directory that can't be read at the delete); the
  // removal goes piece by piece, so the directory may be kept only in part.
  // {path}: the directory (admin route only); {code}: the errno code, else
  // UNKNOWN. A second uninstall finishes it.
  MODULE_DATA_NOT_REMOVED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module's stored data and its registry entry, if any, are gone, but its data directory {path} could not be removed ({code}), so it is kept, perhaps only in part -- fix the cause (a full or read-only disk, its permissions), then uninstall again to remove it, or remove it by hand"},
  // An uninstall's early read of the data directory failed with an errno
  // other than ENOENT/ENOTDIR (permissions, a link that loops), before
  // anything was removed. {path}: the directory (the answer reaches only the
  // operator's admin route); {code}: the errno code.
  MODULE_DATA_UNREADABLE: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module was not uninstalled: its data directory {path} could not be read ({code}), so nothing was removed -- make it readable (its permissions, or a link that loops), then uninstall again"},
  MODULE_LOADED: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module is loaded, restarting or suspended -- unload it first (POST /unload-module), then uninstall it"},
  MODULE_DATA_NOT_DIRECTORY: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "The module's data directory is not a real directory (a link or a file) -- it was left alone; remove it by hand under --moduleDataPath"},
  MODULE_PATH_OUTSIDE_ROOT: {kind: 'operator', retryable: false, httpStatus: 500, mcpCode: null,
    en: "With --hardened, every module must live under --modulePath -- move the module there or load it from there"},
  MODULE_NAME_MISMATCH: {kind: 'caller', retryable: false, httpStatus: 400, mcpCode: null,
    en: "The load request names a module differently from its package.json -- load it under its package.json name"}
};

module.exports = {CODES: Object.freeze(Object.fromEntries(Object.entries(CODES).map(([k, v]) => [k, Object.freeze(v)])))};

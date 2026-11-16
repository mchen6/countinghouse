'use strict';
// Keys the framework injects into a call's argument object itself, rather
// than the module declaring them: the Session (`ctx`, set by
// lib/routes/invoke-action.js and dropped again before any worker boundary),
// the raw request headers (`httpHeaders`, same place), `jobID`
// (lib/device-manager.js's invokeJobs), `usageCall` (the usage counters' call
// id: lib/mcp/gateway.js for a tools/call, and a task's run; local-mode spec
// §5), the per-call `token` (R2-1) and `wantsProgress` (the client asked for
// progress, so the handler's own reports are posted: MCP completeness M21,
// lib/handler-ctx.js). They are not action arguments and are
// never validated, but they are legal (lib/service.js). A validator is sent
// a call's value without them (lib/module-spec.js validatorView): least
// privilege, as it never needs them.
module.exports = Object.freeze({ctx: true, httpHeaders: true, jobID: true, usageCall: true, token: true, wantsProgress: true});

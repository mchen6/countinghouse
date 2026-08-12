// MCP JSON-RPC 2.0 method dispatch. Transport-agnostic on purpose -- lib/routes/mcp.js
// is the only thing that knows this is running over stateless Streamable HTTP; this
// file just takes a parsed JSON-RPC request object and a callback.
var userAuth     = require('../user-auth');
var toolRegistry = require('./tool-registry');
var JobControl   = require('../job-control');
var options      = require('../cli-options');
var LOG          = require('../logger');
var encodeLegacyTool = require('../metering/redis-provider').encodeLegacyTool;

var PROTOCOL_VERSION = '2026-07-28';
var SERVER_NAME      = 'countinghouse';
var SERVER_VERSION   = require('../../package.json').version;

var JSONRPC_PARSE_ERROR      = -32700;
var JSONRPC_INVALID_REQUEST  = -32600;
var JSONRPC_METHOD_NOT_FOUND = -32601;
var JSONRPC_INVALID_PARAMS   = -32602;
var JSONRPC_INTERNAL_ERROR   = -32603;

function errorResponse(id, code, message) {
  return {jsonrpc: '2.0', id: (id === undefined ? null : id), error: {code: code, message: message}};
}

function resultResponse(id, result) {
  return {jsonrpc: '2.0', id: id, result: result};
}

// This server's request/response handling has no version-specific branches --
// tools/list and tools/call are shaped the same way regardless of which
// protocolVersion the client negotiates. So instead of unilaterally forcing
// our own preferred version and refusing anything else, we echo back whatever
// version the client asked for in its `initialize` call: cheap to support,
// and it keeps us working with clients built against slightly different spec
// dates without a hardcoded compatibility table to maintain.
// Tasks (job-control mapped onto MCP's tasks/* extension) only work when the
// server is running in multi-thread mode -- lib/job-control.js's addJob/getJob/
// removeJob/listJobs all require options.workerThread === true (job execution
// happens by shipping the action call to a worker thread), so the capability
// is only advertised, and tasks/* only answered, when that's the case.
function tasksSupported() {
  return options.workerThread === true;
}

// Resolves the caller's apiKey into the {appKey, isAdmin} ownership context
// lib/job-control.js's tasks/* gate expects.
//
// deviceID/serviceID/actionName are all null: a task is addressed by taskId,
// and which device it happens to target is not what authorizes reading it --
// ownership is (the creator's apiKey). This is the same device-independent
// use of doUserAuth that lib/routes/admin-only.js already makes, and it is
// what supplies `isAdmin`, which is the only way to legitimately read across
// tenants. A null/unknown apiKey fails here (SYSTEM_ERROR_UNKNOWN_USER),
// which is why every tasks/* method below now requires a key at all --
// previously none of them took one.
//
// Under --debug this returns isAdmin: true for any key (lib/user-auth.js's
// debug branch), so debug-mode callers keep seeing every task, consistent
// with every other capability that mode bypasses.
function resolveTaskAuth(appKey, callback) {
  userAuth(null, null, null, appKey, null, null, function() {}, function(err, session) {
    if (err != null) return callback(err);
    return callback(null, {appKey: session.appKey, isAdmin: session.isAdmin === true});
  });
}

function handleInitialize(req, cdifInterface, callback) {
  var params = req.params || {};
  var negotiatedVersion = (typeof(params.protocolVersion) === 'string' && params.protocolVersion !== '')
    ? params.protocolVersion
    : PROTOCOL_VERSION;

  var capabilities = {tools: {}};
  if (tasksSupported() === true) {
    capabilities.tasks = {
      list:   {},
      cancel: {},
      requests: {tools: {call: {}}}
    };
  }

  return callback(null, resultResponse(req.id, {
    protocolVersion: negotiatedVersion,
    capabilities: capabilities,
    serverInfo: {
      name:    SERVER_NAME,
      version: SERVER_VERSION
    }
  }));
}

function handlePing(req, cdifInterface, callback) {
  return callback(null, resultResponse(req.id, {}));
}

function handleToolsList(req, cdifInterface, appKey, callback) {
  toolRegistry.buildToolList(cdifInterface, appKey, function(err, tools) {
    if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    return callback(null, resultResponse(req.id, {tools: tools}));
  });
}

// shapes a plain (err, data) result the way every tools/call response is
// shaped -- content/isError/structuredContent -- shared by the platform
// check-balance tool, the regular device-tool invoke path, and tasks/result.
function toolCallResult(err, data) {
  if (err != null) {
    var result = {
      isError: true,
      content: [{type: 'text', text: (err.message != null ? err.message : String(err))}]
    };
    // CHError/DeviceError carry a locale-independent `code` (see Sprint 4's
    // worker-message.js fix, which is what makes `code` survive a cross-worker
    // hop intact). HTTP invoke-action responses already expose it
    // (lib/session.js); surface it here too via structuredContent so MCP
    // clients get the same locale-independent error classification instead
    // of having to pattern-match translated message text. Plain Error
    // objects (request-validation failures raised in this file) have no
    // `code`, so they're unaffected.
    if (err.code != null) result.structuredContent = {code: err.code};
    return result;
  }
  return {
    isError: false,
    content: [{type: 'text', text: JSON.stringify(data == null ? {} : data)}],
    structuredContent: (data == null ? {} : data)
  };
}

function handleToolsCall(req, cdifInterface, appKey, callback) {
  var params = req.params || {};
  var name      = params.name;
  var toolArgs  = params.arguments || {};

  if (typeof(name) !== 'string' || name === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.name must be a non-empty string'));
  }

  // platform tool, not derived from any device module -- handled directly,
  // no task-augmentation support (it's already a fast, synchronous read).
  if (name === 'countinghouse_check_balance') {
    if (appKey == null) {
      return callback(null, resultResponse(req.id, toolCallResult(new Error('must supply an X-CH-Key header to check balance'))));
    }
    return cdifInterface.checkBalance(appKey, function(err, result) {
      return callback(null, resultResponse(req.id, toolCallResult(err, result)));
    });
  }

  var targets = toolRegistry.buildToolTargets(cdifInterface);
  var target  = targets[name];

  if (target == null) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'unknown tool: ' + name));
  }

  // task-augmented request: caller wants this call to run as a trackable
  // background task (tasks/get, tasks/result, tasks/cancel) instead of
  // blocking for the result inline.
  if (params.task != null) {
    return createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback);
  }

  var args = {input: toolArgs};

  userAuth(null, null, target.deviceID, appKey, target.serviceID, target.actionName, function(err, data) {
    var result = toolCallResult(err, data);
    // record the call (see options.mcpToolCallCost) only on success and only
    // when we know who to bill -- fire-and-forget, matching the existing
    // (also fire-and-forget) lib/session.js billing call this bypasses for
    // MCP-originated invocations.
    if (result.isError !== true && appKey != null) {
      // The metering identity is encodeLegacyTool(deviceID, serviceID,
      // actionName), not the MCP tool name: the same action reached over
      // HTTP invoke-action, over a cross-worker call, or over MCP must
      // produce the *same* record, or a per-tool price/quota is silently
      // per-entry-path. The two cross-worker paths (lib/device-manager.js,
      // lib/peer-channel-broker.js) already used this encoding; MCP's
      // slugified tool name was the odd one out, and it isn't even stable
      // (tools/list dedups collisions with a _2 suffix). The MCP name is
      // still what identifies the *tool* to clients -- it just isn't what
      // identifies the *billable action* to MeteringProvider.
      cdifInterface.recordCall(appKey, encodeLegacyTool(target.deviceID, target.serviceID, target.actionName),
                               options.mcpToolCallCost, function(err) {
        if (err) LOG.E(err);
      });
    }
    return callback(null, resultResponse(req.id, result));
  }, function(err, session) {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }
    session.localInput = args;
    cdifInterface.invokeDeviceAction(target.deviceID, target.serviceID, target.actionName, args, null, session);
  });
}

function createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback) {
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS,
      'task-augmented tools/call requires the server to be running in multi-thread mode (--workerThread)'));
  }

  // Same userAuth gate (device ownership, not just identity) the
  // synchronous tools/call path applies below. Without this, task creation
  // (JobControl.addJob) never checks it, and job execution (job-control.js's
  // worker -> cdifInterface.invokeJobs -> DeviceManager.onInvokeJobs) has no
  // appKey parameter to check it with either -- so any apiKey could
  // task-augment a call against a device it doesn't own and have it run to
  // completion. Found via docs/cross-cutting-matrix.md. The resulting
  // session is discarded (localCB is a no-op): job execution is a separate
  // path (JobControl.addJob/invokeJobs) that doesn't use it -- this call is
  // purely an authorization gate, matching the same JSONRPC_INTERNAL_ERROR
  // shape the synchronous path already uses for a userAuth failure.
  userAuth(null, null, target.deviceID, appKey, target.serviceID, target.actionName, function() {}, function(err, session) {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }

    // The session is no longer discarded: its resolved identity is what the
    // created job records as its owner (and billing subject), so that
    // tasks/get|result|cancel can later match against it.
    var authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    // task creation (JobControl.addJob, below) never goes through
    // CdifInterface.prototype.invokeDeviceAction, so it doesn't automatically
    // inherit that path's rate-limit checks the way a synchronous tools/call
    // does -- without this, a caller could bypass --apiKeyRateLimit entirely
    // by always task-augmenting their calls, queueing jobs without limit.
    // Checked at task *creation* time (not per-execution), matching where the
    // resource-abuse actually happens: unbounded queue growth.
    if (appKey != null) {
      return cdifInterface.rateLimit(appKey, function(err, result) {
        if (err == null && result.limited === true) {
          return callback(null, resultResponse(req.id, toolCallResult(new Error('rate limit exceeded'))));
        }
        return doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback);
      });
    }
    return doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback);
  });
}

function doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback) {
  // job-control groups jobs by a "name" (used for scheduler IDs and history
  // lookups) -- the tool name is a natural fit, since it's already the stable,
  // deterministic identifier tools/list and tools/call agree on. The owning
  // apiKey no longer rides inside jobOpts: it comes from `authCtx`, which
  // addJob takes as its first argument precisely so a request-supplied value
  // can never be mistaken for an authenticated one (see addJob's comment).
  // It is what lib/job-control.js's worker records the call against once the
  // job completes (see initJobProcess) -- this path never goes through
  // lib/session.js's Session/logAPICall machinery at all -- and what
  // tasks/get|result|cancel later match ownership against.
  var jobOpts = {name: target.name};

  JobControl.addJob(authCtx, jobOpts, target.deviceID, target.serviceID, target.actionName, toolArgs, function(err, result) {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }

    var now = new Date().toISOString();
    var params = req.params || {};
    // ttl here is purely informational -- job-control has no result-expiry
    // mechanism, so a requested ttl isn't actually enforced. It is NOT the
    // same thing as job-control's own jobOpts.timeout (an execution deadline,
    // not a post-completion retention window), so it's never mapped onto it.
    var ttl = (params.task && typeof(params.task.ttl) === 'number') ? params.task.ttl : null;

    return callback(null, resultResponse(req.id, {
      task: {
        taskId: String(result.id),
        status: 'working',
        ttl: ttl,
        createdAt: now,
        lastUpdatedAt: now
      }
    }));
  });
}

function bullmqStateToTaskStatus(state) {
  switch (state) {
    case 'completed': return 'completed';
    case 'failed':     return 'failed';
    default:           return 'working'; // waiting/waiting-children/delayed/active/stalled/unknown
  }
}

// converts a job-control {job, state} record (the shape getJob/listJobs
// return) into an MCP TaskSchema object.
function jobToTask(record) {
  var job = record.job;
  var updateCandidates = [job.finishedOn, job.processedOn, job.timestamp].filter(function(t) { return t != null; });
  var lastUpdated = updateCandidates.length > 0 ? Math.max.apply(null, updateCandidates) : job.timestamp;

  var task = {
    taskId:        String(job.id),
    status:        bullmqStateToTaskStatus(record.state),
    ttl:           (job.opts != null && job.opts.timeout != null) ? job.opts.timeout : null,
    createdAt:     new Date(job.timestamp).toISOString(),
    lastUpdatedAt: new Date(lastUpdated).toISOString()
  };

  if (record.state === 'failed' && job.failedReason != null) {
    task.statusMessage = job.failedReason;
  }

  return task;
}

function handleTasksGet(req, cdifInterface, appKey, callback) {
  var params = req.params || {};
  var taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveTaskAuth(appKey, function(authErr, authCtx) {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }
    JobControl.getJob(authCtx, taskId, function(err, record) {
      if (err != null) {
        // "unknown task" for both a genuinely missing id and one owned by
        // someone else -- deliberately indistinguishable, so this can't be
        // used to enumerate other tenants' taskIds.
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'unknown task: ' + taskId));
      }
      // GetTaskResultSchema merges TaskSchema directly into the result (not
      // wrapped under a `task` key, unlike CreateTaskResultSchema).
      return callback(null, resultResponse(req.id, jobToTask(record)));
    });
  });
}

function handleTasksResult(req, cdifInterface, appKey, callback) {
  var params = req.params || {};
  var taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveTaskAuth(appKey, function(authErr, authCtx) {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }
    return doHandleTasksResult(req, authCtx, taskId, callback);
  });
}

function doHandleTasksResult(req, authCtx, taskId, callback) {
  JobControl.getJob(authCtx, taskId, function(err, record) {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'unknown task: ' + taskId));
    }

    var status = bullmqStateToTaskStatus(record.state);

    // the result of a task-augmented tools/call is shaped exactly like a
    // normal (synchronous) tools/call result -- same content/isError/
    // structuredContent contract either way, via the shared toolCallResult
    // helper above.
    if (status === 'completed') {
      return callback(null, resultResponse(req.id, toolCallResult(null, record.job.returnvalue)));
    }
    if (status === 'failed') {
      var failedReason = record.job.failedReason != null ? record.job.failedReason : 'task failed';
      // decode the "CODE: message" prefix job-control.js's worker encodes a
      // failed job's error with (see the matching encode there) -- bullmq
      // itself only persists job.failedReason as a plain string, dropping
      // any `code` a CHError/DeviceError had, so without this a
      // task-augmented failure would never carry the same locale-
      // independent code a synchronous tools/call failure gets via
      // toolCallResult below.
      var codeMatch = /^([A-Z][A-Z0-9_]*): /.exec(failedReason);
      var failErr = new Error(codeMatch != null ? failedReason.slice(codeMatch[0].length) : failedReason);
      if (codeMatch != null) failErr.code = codeMatch[1];
      return callback(null, resultResponse(req.id, toolCallResult(failErr)));
    }
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'task ' + taskId + ' has not completed yet (status: ' + status + ')'));
  });
}

function handleTasksList(req, cdifInterface, appKey, callback) {
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveTaskAuth(appKey, function(authErr, authCtx) {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }
    // listJobs filters to this caller's own jobs (see its comment) -- an
    // empty list is the correct answer for a caller with none, not an error.
    JobControl.listJobs(authCtx, function(err, records) {
      if (err != null) {
        return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
      }
      return callback(null, resultResponse(req.id, {tasks: records.map(jobToTask)}));
    });
  });
}

function handleTasksCancel(req, cdifInterface, appKey, callback) {
  var params = req.params || {};
  var taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveTaskAuth(appKey, function(authErr, authCtx) {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }

    JobControl.getJob(authCtx, taskId, function(err, record) {
      if (err != null) {
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'unknown task: ' + taskId));
      }

      // bullmq's job.remove() deletes the job outright rather than leaving it
      // queryable in a terminal state, so the task shape is captured *before*
      // removing and its status is forced to 'cancelled' for this response --
      // a subsequent tasks/get for this taskId will correctly report "unknown
      // task" once it's actually gone.
      var task = jobToTask(record);
      task.status = 'cancelled';

      // removeJob re-checks ownership itself rather than trusting the getJob
      // above -- the gate belongs on every mutating entry point, not on the
      // read that happened to precede it.
      JobControl.removeJob(authCtx, record.job.name, taskId, false, function(removeErr) {
        if (removeErr != null) {
          return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, removeErr.message || String(removeErr)));
        }
        return callback(null, resultResponse(req.id, task));
      });
    });
  });
}

// notifications (no `id`) never get a response -- per JSON-RPC 2.0 and MCP's
// Streamable HTTP transport, the server MUST NOT write a body for these.
var NOTIFICATION_METHODS = {
  'notifications/initialized': true
};

// handles exactly one JSON-RPC request/notification object. batching (an array
// of these) is handled by the route layer, which calls this once per entry.
function handle(req, cdifInterface, appKey, callback) {
  if (req == null || typeof(req) !== 'object' || req.jsonrpc !== '2.0' || typeof(req.method) !== 'string') {
    return callback(null, errorResponse(req && req.id, JSONRPC_INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'));
  }

  if (NOTIFICATION_METHODS[req.method] === true) {
    return callback(null, null); // no response for notifications
  }

  switch (req.method) {
    case 'initialize':   return handleInitialize(req, cdifInterface, callback);
    case 'ping':          return handlePing(req, cdifInterface, callback);
    case 'tools/list':    return handleToolsList(req, cdifInterface, appKey, callback);
    case 'tools/call':    return handleToolsCall(req, cdifInterface, appKey, callback);
    // appKey is threaded into tasks/* exactly the way it already was into
    // tools/* -- its absence from these four signatures was the whole of the
    // bug: with no key in scope there was nothing to authorize against, so
    // any caller (including one with no key at all) could read, enumerate,
    // and cancel every tenant's tasks.
    case 'tasks/get':     return handleTasksGet(req, cdifInterface, appKey, callback);
    case 'tasks/result':  return handleTasksResult(req, cdifInterface, appKey, callback);
    case 'tasks/list':    return handleTasksList(req, cdifInterface, appKey, callback);
    case 'tasks/cancel':  return handleTasksCancel(req, cdifInterface, appKey, callback);
    default:
      return callback(null, errorResponse(req.id, JSONRPC_METHOD_NOT_FOUND, 'method not found: ' + req.method));
  }
}

module.exports = {
  handle: handle,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  JSONRPC_PARSE_ERROR: JSONRPC_PARSE_ERROR,
  errorResponse: errorResponse
};

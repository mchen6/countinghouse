// MCP JSON-RPC 2.0 method dispatch. Transport-agnostic on purpose -- lib/routes/mcp.js
// is the only thing that knows this is running over stateless Streamable HTTP; this
// file just takes a parsed JSON-RPC request object and a callback.
var userAuth     = require('../user-auth');
var toolRegistry = require('./tool-registry');
var JobControl   = require('../job-control');
var options      = require('../cli-options');
var LOG          = require('../logger');

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
    return {
      isError: true,
      content: [{type: 'text', text: (err.message != null ? err.message : String(err))}]
    };
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
      cdifInterface.recordCall(appKey, name, options.mcpToolCallCost, function(err) {
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
      return doCreateTaskForToolCall(req, target, toolArgs, appKey, callback);
    });
  }
  return doCreateTaskForToolCall(req, target, toolArgs, appKey, callback);
}

function doCreateTaskForToolCall(req, target, toolArgs, appKey, callback) {
  // job-control groups jobs by a "name" (used for scheduler IDs and history
  // lookups) -- the tool name is a natural fit, since it's already the stable,
  // deterministic identifier tools/list and tools/call agree on. apiKey rides
  // along on the job data so lib/job-control.js's worker can record the call
  // once it actually completes (see initJobProcess) -- this path never goes
  // through lib/session.js's Session/logAPICall machinery at all.
  var jobOpts = {name: target.name, apiKey: appKey};

  JobControl.addJob(jobOpts, target.deviceID, target.serviceID, target.actionName, toolArgs, function(err, result) {
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

function handleTasksGet(req, cdifInterface, callback) {
  var params = req.params || {};
  var taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  JobControl.getJob(taskId, function(err, record) {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'unknown task: ' + taskId));
    }
    // GetTaskResultSchema merges TaskSchema directly into the result (not
    // wrapped under a `task` key, unlike CreateTaskResultSchema).
    return callback(null, resultResponse(req.id, jobToTask(record)));
  });
}

function handleTasksResult(req, cdifInterface, callback) {
  var params = req.params || {};
  var taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  JobControl.getJob(taskId, function(err, record) {
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
      return callback(null, resultResponse(req.id, toolCallResult(
        new Error(record.job.failedReason != null ? record.job.failedReason : 'task failed')
      )));
    }
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'task ' + taskId + ' has not completed yet (status: ' + status + ')'));
  });
}

function handleTasksList(req, cdifInterface, callback) {
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  JobControl.listJobs(function(err, records) {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }
    return callback(null, resultResponse(req.id, {tasks: records.map(jobToTask)}));
  });
}

function handleTasksCancel(req, cdifInterface, callback) {
  var params = req.params || {};
  var taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  JobControl.getJob(taskId, function(err, record) {
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

    JobControl.removeJob(record.job.name, taskId, false, function(removeErr) {
      if (removeErr != null) {
        return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, removeErr.message || String(removeErr)));
      }
      return callback(null, resultResponse(req.id, task));
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
    case 'tasks/get':     return handleTasksGet(req, cdifInterface, callback);
    case 'tasks/result':  return handleTasksResult(req, cdifInterface, callback);
    case 'tasks/list':    return handleTasksList(req, cdifInterface, callback);
    case 'tasks/cancel':  return handleTasksCancel(req, cdifInterface, callback);
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

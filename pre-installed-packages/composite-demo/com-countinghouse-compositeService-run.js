// Demo-fixed per-hop cost. A real deployment would look this up from each
// target module's own declared pricing rather than hardcoding it here.
var HOP_COST = 1;

function run(args, callback) {
  var _this = this;
  var input = args.input;

  if (input == null || typeof(input.text) !== 'string') {
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }

  if (this.transformClient == null || this.echoClient == null) {
    return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', 'inner service clients not ready yet'), null);
  }

  var bill = [];

  function recordHop(tool, next) {
    CHUtil.recordCall(_this.internalApiKey, tool, HOP_COST, function(err, result) {
      // a metering failure shouldn't take down the whole composite call --
      // the hop itself already succeeded, so note the gap in the bill and
      // keep going, rather than failing the caller's request over
      // bookkeeping.
      bill.push({
        hop:     bill.length + 1,
        tool:    tool,
        charged: (err == null) ? result.charged : null,
        balance: (err == null) ? result.balance : null
      });
      return next();
    });
  }

  // hop 1: transform-demo/uppercase
  this.transformClient.invoke({actionName: 'uppercase', input: {text: input.text}}, function(err, data) {
    if (err != null) return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', err.message), null);

    var upperText = data.output.text;

    recordHop('transform-demo/uppercase', function() {
      // hop 2: echo-device-module/echo -- echo's own input schema requires
      // {foo: array, bar: string}, so the uppercased text rides along as `bar`
      _this.echoClient.invoke({actionName: 'echo', input: {foo: [], bar: upperText}}, function(err, data) {
        if (err != null) return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', err.message), null);

        var finalText = data.output.bar;

        recordHop('echo-device-module/echo', function() {
          return callback(null, {
            output: {
              finalText: finalText,
              bill: bill
            }
          });
        });
      });
    });
  });
}

module.exports = run;

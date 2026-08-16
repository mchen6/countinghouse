// Demo-fixed per-hop cost, used only for this module's own app-layer
// audit trail (CHUtil.recordUsage below). The real per-hop charge/balance
// in `bill` comes from the platform's own automatic metering instead (see
// recordHop).
const HOP_COST = 1;

function run(args, callback) {
  const _this = this;
  const input = args.input;

  if (input == null || typeof(input.text) !== 'string') {
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }

  if (this.transformClient == null || this.echoClient == null) {
    return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', 'inner service clients not ready yet'), null);
  }

  const bill = [];

  // `platformMetering` is populated automatically by the platform as a 3rd,
  // additive arg on every cross-worker ServiceClient.invoke() reply, on
  // both the main-thread-routed and --directPeerChannels paths (see
  // lib/device-manager.js's sendInvokeActionMessageToWorker and
  // lib/peer-channel-broker.js's handleMeteringRequest) -- it is the only
  // thing that ever deducts balance for a hop. Deliberately never merged
  // into `data` itself: `data` is the hop's own action output, and some
  // modules pass it straight through as their own return value, so an
  // extra field there would break that pass-through's own output
  // validation. CHUtil.recordUsage is this module's own app-layer
  // bookkeeping only and never touches balance (see its comment in
  // lib/countinghouse-util.js); this file used to call the
  // balance-deducting CHUtil.recordCall here too, which double-billed
  // every hop.
  function recordHop(tool, platformMetering, next) {
    CHUtil.recordUsage(_this.internalApiKey, tool, HOP_COST, () => {});

    bill.push({
      hop:     bill.length + 1,
      tool:    tool,
      charged: (platformMetering != null) ? platformMetering.charged : null,
      balance: (platformMetering != null) ? platformMetering.balance : null
    });
    return next();
  }

  // hop 1: transform-demo/uppercase
  this.transformClient.invoke({actionName: 'uppercase', input: {text: input.text}}, (err, data, platformMetering) => {
    if (err != null) return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', err.message), null);

    const upperText = data.output.text;

    recordHop('transform-demo/uppercase', platformMetering, () => {
      // hop 2: echo-device-module/echo -- echo's own input schema requires
      // {foo: array, bar: string}, so the uppercased text rides along as `bar`
      _this.echoClient.invoke({actionName: 'echo', input: {foo: [], bar: upperText}}, (err, data, platformMetering) => {
        if (err != null) return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', err.message), null);

        const finalText = data.output.bar;

        recordHop('echo-device-module/echo', platformMetering, () => {
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

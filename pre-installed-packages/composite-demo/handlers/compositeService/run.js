// One MCP tools/call fanning out into two in-process, metered hops.
//
// 6.0.0 shape: no index.js, no device.js, no setAction. The clients are built
// per call from ctx rather than once in a constructor, which is what lets each
// hop be billed to the real outer caller while still being *authorized* as
// this module's own identity -- so a caller needs no grant to transform-demo
// or echo-device-module. See docs/composite-tools.md.

// deviceIDs are deterministic (UUIDv5 of a fixed namespace + the target
// module's api.json friendlyName -- see lib/countinghouse-device.js), so they
// can be computed offline rather than discovered at runtime.
const ECHO_DEVICE_ID      = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module ("echo-device")
const TRANSFORM_DEVICE_ID = 'a53ef5c7-cc2f-5264-9811-44f1611685ee'; // transform-demo

const ECHO_SERVICE      = 'urn:countinghouse-com:serviceID:echoService';
const TRANSFORM_SERVICE = 'urn:countinghouse-com:serviceID:transformService';

// The identity the inner hops are AUTHORIZED as. Billing does not use it:
// ctx.serviceClient bills ctx.caller. This key still needs a grant to the two
// target devices -- see docs/composite-tools.md's table of module identities.
const AS_IDENTITY = 'composite-demo-internal';

// Demo-fixed per-hop cost, used only for this module's own app-layer audit
// trail (ctx.recordUsage below). The real per-hop charge/balance in `bill`
// comes from the platform's own automatic metering instead.
const HOP_COST = 1;

function clientFor(ctx, deviceID, serviceID) {
  return new Promise((resolve, reject) => {
    ctx.serviceClient({deviceID: deviceID, serviceID: serviceID, as: AS_IDENTITY}, (err, client) => {
      if (err != null) return reject(err);
      return resolve(client);
    });
  });
}

// platformMetering is the 3rd, additive argument on every cross-worker
// ServiceClient.invoke reply, on both hop paths. It is deliberately never
// merged into `data`: `data` is the hop's own validated output, and a module
// passing it straight through as its own return value would fail validation
// on the injected field.
function invokeHop(client, actionName, input) {
  return new Promise((resolve, reject) => {
    client.invoke({actionName: actionName, input: input}, (err, data, platformMetering) => {
      if (err != null) return reject(err);
      return resolve({data: data, platformMetering: platformMetering});
    });
  });
}

module.exports = async (input, ctx) => {
  if (input == null || typeof(input.text) !== 'string') {
    throw new DeviceError('ARGUMENTS_INVALID');
  }

  const bill = [];
  const recordHop = (tool, platformMetering) => {
    // app-layer bookkeeping only -- never touches balance (see
    // lib/countinghouse-util.js's recordUsage). Recorded against ctx.caller,
    // the same subject the platform charged.
    ctx.recordUsage(tool, HOP_COST, () => {});

    bill.push({
      hop:     bill.length + 1,
      tool:    tool,
      charged: (platformMetering != null) ? platformMetering.charged : null,
      balance: (platformMetering != null) ? platformMetering.balance : null
    });
  };

  const transformClient = await clientFor(ctx, TRANSFORM_DEVICE_ID, TRANSFORM_SERVICE);
  const echoClient      = await clientFor(ctx, ECHO_DEVICE_ID, ECHO_SERVICE);

  // hop 1: transform-demo/uppercase
  let first;
  try {
    first = await invokeHop(transformClient, 'uppercase', {text: input.text});
  } catch (e) {
    throw new DeviceError('DEVICE_ACTION_CALL_FAIL', e.message);
  }
  recordHop('transform-demo/uppercase', first.platformMetering);

  // hop 2: echo-device-module/echo -- echo's input schema requires
  // {foo: array, bar: string}, so the uppercased text rides along as `bar`
  let second;
  try {
    second = await invokeHop(echoClient, 'echo', {foo: [], bar: first.data.output.text});
  } catch (e) {
    throw new DeviceError('DEVICE_ACTION_CALL_FAIL', e.message);
  }
  recordHop('echo-device-module/echo', second.platformMetering);

  return {output: {finalText: second.data.output.bar, bill: bill}};
};

// One MCP tools/call fanning out into two in-process, metered hops.
//
// 6.0.0 shape: no index.js, no device.js, no setAction. The clients are built
// per call from ctx rather than once in a constructor, which is what lets each
// hop be billed to the real outer caller while still being *authorized* as
// this module's own identity -- so a caller needs no grant to transform-demo
// or echo-device-module. See docs/composite-tools.md.

// The two hops are called by name (ctx.call), as package.json's
// "countinghouse.calls" declares them: the runtime resolves each to its
// device, never this module (no device ID here).
const TRANSFORM = 'transform-demo/transformService.uppercase';
const ECHO      = 'echo-device/echoService.echo';

// The identity the inner hops are AUTHORIZED as is the operator's
// runsModules binding for this module, never named here (R2-1); billing goes
// to ctx.caller. That identity still needs a grant to the two target devices
// -- see docs/composite-tools.md's table of module identities.

// Demo-fixed per-hop cost, used only for this module's own app-layer audit
// trail (ctx.recordUsage below). The real per-hop charge/balance in `bill`
// comes from the platform's own automatic metering instead.
const HOP_COST = 1;

// ctx.call with detail: {data, platformMetering}. platformMetering is
// deliberately never merged into `data`: `data` is the hop's own validated
// output, and a module passing it straight through as its own return value
// would fail validation on the injected field.
const hop = (ctx, address, input) => ctx.call(address, input, {detail: true});

module.exports = async (input, ctx) => {
  if (input == null || typeof(input.text) !== 'string') {
    return ctx.error('INPUT_REJECTED', 'text must be a string');
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

  // hop 1: transform-demo/uppercase
  let first;
  try {
    first = await hop(ctx, TRANSFORM, {text: input.text});
  } catch (e) {
    return ctx.error('INNER_CALL_FAILED', e.message, {cause: e});
  }
  recordHop('transform-demo/uppercase', first.platformMetering);

  // hop 2: echo-device-module/echo -- echo's input schema requires
  // {foo: array, bar: string}, so the uppercased text rides along as `bar`
  let second;
  try {
    second = await hop(ctx, ECHO, {foo: [], bar: first.data.output.text});
  } catch (e) {
    return ctx.error('INNER_CALL_FAILED', e.message, {cause: e});
  }
  recordHop('echo-device-module/echo', second.platformMetering);

  return {output: {finalText: second.data.output.bar, bill: bill}};
};

// The module's own error, returned: a code that is also a catalogue name
// (still the module's), or one of its own.
module.exports = async (input, ctx) => {
  if (input.kind === 'catalogue') return ctx.error('DEVICE_NOT_FOUND', 'no row 7', {row: 7});
  return ctx.error('SHAPE_GONE', 'the shape is gone', {n: 1});
};

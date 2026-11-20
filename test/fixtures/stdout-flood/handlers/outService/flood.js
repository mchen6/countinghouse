// input.mb megabytes to stdout, 64 KiB a write, as fast as the worker can.
module.exports = async (input) => {
  const started = Date.now();
  const chunk = `${'x'.repeat(65535)}\n`;
  for (let i = 0; i < input.mb * 16; i++) process.stdout.write(chunk);
  return {output: {ms: Date.now() - started}};
};

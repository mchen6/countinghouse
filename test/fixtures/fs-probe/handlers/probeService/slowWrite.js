// slowWrite.js -- starts writing 8 MB to /tmp/slow and returns at once, so a
// test can restart or crash the worker while the broker is still writing.
module.exports = async () => {
  require('fs').promises.writeFile('/tmp/slow', Buffer.alloc(8 * 1024 * 1024)).catch(() => {});
  return {output: {ok: true, code: null}};
};

// Shared by every operator JSON file the server reads and reports errors in:
// the auth config (lib/auth/file-provider.js), device configs
// (lib/device-config.js) and the --modulePolicy file (lib/module-policy.js).
// They hold keys, backend credentials and env values.
// Where a JSON syntax error is, as "at line L, column C", never what is
// there: V8's JSON.parse messages quote the input around the error
// ('Unexpected token \'x\', ..."ey-0123": xyz}" is not valid JSON'), which in
// an auth file is part of a key. The location comes from the message's
// "position N" when there is one, else from finding V8's quoted context in
// the input (used to locate, never printed). With neither, no location.
function jsonSyntaxWhere(e, raw) {
  const msg = (e != null && typeof(e.message) === 'string') ? e.message : '';
  let pos = null;
  const lc = /\(line (\d+) column (\d+)\)/.exec(msg);
  if (lc != null) return ` at line ${lc[1]}, column ${lc[2]}`;
  const p = /at position (\d+)/.exec(msg);
  if (p != null) pos = parseInt(p[1], 10);
  if (pos == null) {
    const ctx = /Unexpected token '(.)', (?:\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON/.exec(msg);
    if (ctx != null) {
      const at = raw.indexOf(ctx[2]);
      const off = ctx[2].indexOf(ctx[1]);
      if (at !== -1 && off !== -1) pos = at + off;
    }
  }
  if (pos == null || pos < 0 || pos > raw.length) return '';
  const before = raw.slice(0, pos);
  const line = before.split('\n').length;
  const column = pos - before.lastIndexOf('\n');
  return ` at line ${line}, column ${column}`;
}

module.exports = jsonSyntaxWhere;

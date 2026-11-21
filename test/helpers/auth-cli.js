'use strict';
// bin/countinghouse-auth-sqlite.js as a test calls it: a command about a user
// takes its key on stdin, never as an argument (B-meter-keys 4r). A test
// still writes [command, key, ...rest]; this moves the key to stdin.
const KEYED = new Set(['add-user', 'remove-user', 'grant', 'revoke', 'set-admin', 'set-id', 'bind-module']);
// -> {args, input}: the CLI's arguments, and what to pipe to its stdin
function keyed(args) {
  if (Array.isArray(args) && KEYED.has(args[0]) && args.length >= 2) return {args: [args[0]].concat(args.slice(2)), input: `${args[1]}\n`};
  return {args, input: ''};
}
module.exports = {keyed};

// completeThing.js -- a completion action (M11): scans its input and ctx
// (within the gateway's 2 s: the realm is the worker's, which auth 53's read
// and task scan) and answers what it found as values (each a string of at
// most 256 characters, as the runtime keeps them).
const view = require('../../view');

module.exports = async (input, ctx) => {
  const v = view(input, ctx, {realm: false});
  const caller = v.caller || {};
  return {output: {values: [`hits:${v.hitCount}`, `budget:${v.budgetExhausted}`, `callerKeys:${Object.keys(caller).sort().join(',')}`,
    `id:${caller.id}`, `admin:${caller.isAdmin}`, `ctxKeys:${(v.ctxKeys || []).join(',')}`.slice(0, 256), `first:${JSON.stringify(v.hits[0] || null).slice(0, 200)}`]}};
};

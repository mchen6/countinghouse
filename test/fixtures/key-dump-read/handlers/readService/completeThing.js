// completeThing.js -- a completion action (M11): scans what it can reach and
// answers it as values (each a string of at most 256 characters, as the
// runtime keeps them).
const view = require('../../view');

module.exports = async (input, ctx) => {
  const v = view(input, ctx);
  const caller = v.caller || {};
  return {output: {values: [`hits:${v.hitCount}`, `budget:${v.budgetExhausted}`, `callerKeys:${Object.keys(caller).sort().join(',')}`,
    `id:${caller.id}`, `admin:${caller.isAdmin}`, `first:${JSON.stringify(v.hits[0] || null).slice(0, 200)}`]}};
};

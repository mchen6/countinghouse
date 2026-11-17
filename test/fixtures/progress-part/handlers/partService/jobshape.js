// progress-part fixture (M21): see test/mcp-contract/14-handler-progress-e2e.js
module.exports = (input, ctx) => new Promise((resolve) => {
  ctx.job.info((err, info) => resolve({output: {id: ctx.job.id, infoError: err != null ? err.message : null, info: info === undefined ? null : info}}));
});

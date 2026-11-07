// observe.js -- like probe.js, but answers with what the MODULE saw (its
// error's code and message), which never reaches an MCP client otherwise.
const seen = (e) => ({output: {code: (e && e.code) || null, message: (e && e.message) || null}});
module.exports = (input, ctx) => new Promise((resolve) => {
  ctx.serviceClient({deviceID: input.deviceID, serviceID: 'urn:countinghouse-test:serviceID:endService', as: input.as}, (err, client) => {
    if (err != null) return resolve(seen(err));
    return client.invoke({actionName: 'ping', input: {}}, (e) => resolve(seen(e)));
  });
});

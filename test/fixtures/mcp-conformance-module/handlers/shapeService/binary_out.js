// mcp-conformance fixture (M4): see test/mcp-contract/03-sdk-client-conformance.js
const b64 = (s) => Buffer.from(s).toString('base64');
module.exports = async () => ({output: {caption: 'a chart', chart: b64('png bytes'), clips: [b64('wav one'), b64('wav two!')], doc: b64('%PDF-1.7')}});

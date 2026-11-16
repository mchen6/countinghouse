// m6-part fixture (M6): see test/mcp-contract/16-resources-read.js
module.exports = async () => ({output: {note: Buffer.from('caf\u00e9\n').toString('base64')}});

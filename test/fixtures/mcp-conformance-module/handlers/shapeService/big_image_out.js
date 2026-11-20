// mcp-conformance fixture (M4): a 2 MiB image, inline until M6's 1 MiB threshold links it
module.exports = async () => ({output: {img: Buffer.alloc(2 * 1024 * 1024, 7).toString('base64')}});

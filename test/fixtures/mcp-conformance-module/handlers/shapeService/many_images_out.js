// mcp-conformance fixture (M4): 17 images, one past the limit of 16 a result may carry
module.exports = async () => ({output: {imgs: Array.from({length: 17}, (_, i) => Buffer.from(`png ${i}`).toString('base64'))}});

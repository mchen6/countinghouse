// The whole environment the module's worker was given.
module.exports = async () => ({output: {env: Object.assign({}, process.env)}});

const state = require('../../state.js');

module.exports = async () => ({output: {tampered: state.tamper()}});

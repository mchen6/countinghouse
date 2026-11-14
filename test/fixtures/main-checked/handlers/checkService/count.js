const state = require('../../state.js');

module.exports = async () => ({output: {takes: state.takes, tampered: state.tampered}});

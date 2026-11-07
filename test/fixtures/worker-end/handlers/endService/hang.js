// hang.js -- never answers: the call is in flight whenever the worker ends.
module.exports = () => new Promise(() => {});

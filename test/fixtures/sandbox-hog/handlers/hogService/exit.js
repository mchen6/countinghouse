// exit.js -- process.exit after answering; in a worker it ends only the module.
module.exports = async () => {
  setTimeout(() => process.exit(3), 50);
  return {output: {ok: true}};
};

// An uncaught error whose stack throws when read: the worker's handler must
// log it and carry on.
module.exports = async () => {
  setTimeout(() => {
    const e = new Error('odd');
    Object.defineProperty(e, 'stack', {get() { throw new Error('no stack for you'); }});
    throw e;
  }, 0);
  return {output: {ok: true}};
};

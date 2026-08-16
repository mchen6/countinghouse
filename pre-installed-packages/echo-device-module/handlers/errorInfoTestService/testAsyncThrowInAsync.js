module.exports = async (input, ctx) => {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const t = null.toString();
      return resolve({output: {result: t}});
    }, 1000);
  });
}

async function com_apemesh_errorInfoTestService_testAsyncThrowInAsync(args) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      var t = null.toString();
      return resolve({output: {result: t}});
    }, 1000);
  });
}

module.exports = com_apemesh_errorInfoTestService_testAsyncThrowInAsync;
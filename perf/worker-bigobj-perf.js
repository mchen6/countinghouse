const { Worker, isMainThread, parentPort } = require('node:worker_threads');

if (isMainThread) {
  var total = 10, i = 0, j = 0;

  var bigobj = [];
  for (var b = 0; b < 1024*1024; b++) {
    bigobj.push({foo: 'foo'});
  }

  const worker = new Worker(__filename);
  console.log(Date.now());

  while(true) {
    if (i >= total) break;
    worker.postMessage(bigobj);
    i++;
  }

  worker.on('message', (msg) => {
    if (j === total - 1) {
      console.log(Date.now());
      console.log(msg);
    } else {
      j++;
    }
  });
  return;
}

parentPort.on('message', (msg) => {
  parentPort.postMessage('reply');
});


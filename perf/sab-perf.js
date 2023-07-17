const { Worker, isMainThread, parentPort } = require('node:worker_threads');

if (isMainThread) {
  var total = 1000000, i = 0, j = 0;

  const worker = new Worker(__filename);
  console.log(Date.now());

  const sharedBuffer = new SharedArrayBuffer(1000 * Int32Array.BYTES_PER_ELEMENT);

  while(true) {
    if (i >= total) break;
    worker.postMessage(sharedBuffer);
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


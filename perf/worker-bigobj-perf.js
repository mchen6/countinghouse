const { Worker, isMainThread, parentPort } = require('node:worker_threads');

if (isMainThread) {
  const total = 1000000;
  let i = 0, j = 0;

  const bigobj = [];
  for (let b = 0; b < 128; b++) {
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


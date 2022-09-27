const { Worker, isMainThread, parentPort } = require('node:worker_threads');

if (isMainThread) {
  var total = 1000000, i = 0, j = 0;

  const worker = new Worker(__filename);

//  while(true) {
//    if (i >= total) break;
//    worker.postMessage({foo: 'foo'});
//    i++;
//  }

  worker.on('message', (msg) => {
    if (j === total - 1) {
      console.log(Date.now());
      console.log(msg);
    } else {
      j++;
      worker.postMessage({foo: 'foo'});
    }
  });
  console.log(Date.now());
  worker.postMessage({foo: 'foo'});
  return;
}

parentPort.on('message', (msg) => {
  parentPort.postMessage('reply');
});


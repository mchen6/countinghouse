const cluster = require('node:cluster');
const process = require('node:process');

var total = 1000000, i = 0, j = 0;


if (cluster.isPrimary) {
  const worker = cluster.fork();

  console.log(Date.now());

  while(true) {
    if (i >= total) break;
    worker.send({foo: 'foo'});
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
} else if (cluster.isWorker) {
  process.on('message', (msg) => {
    process.send('reply');
  });
}

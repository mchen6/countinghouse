const cluster = require('node:cluster');
const process = require('node:process');

var total = 1000000, i = 0, j = 0;


if (cluster.isPrimary) {
  const worker = cluster.fork();

  worker.on('message', (msg) => {
    if (j === total - 1) {
      console.log(Date.now());
      console.log(msg);
    } else {
      j++;
      worker.send({foo: 'foo'});
    }
  });
  console.log(Date.now());
  worker.send({foo: 'foo'});
  return;
} else if (cluster.isWorker) {
  process.on('message', (msg) => {
    process.send('reply');
  });
}

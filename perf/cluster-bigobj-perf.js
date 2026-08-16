const cluster = require('node:cluster');
const process = require('node:process');

const total = 1000000;

let i = 0, j = 0;

const bigobj = [];
for (let b = 0; b < 128; b++) {
  bigobj.push({foo: 'foo'});
}


if (cluster.isPrimary) {
  const worker = cluster.fork();

  console.log(Date.now());

  while(true) {
    if (i >= total) break;
    worker.send(bigobj);
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

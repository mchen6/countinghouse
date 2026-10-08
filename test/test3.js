const fs = require('fs');
const cp = require('child_process');
const request = require('supertest');
const url = 'http://127.0.0.1:9527';

const testFiles = fs.readdirSync(`${__dirname}/load-module`);

describe("Start load module test in single thread mode", function () {
  let child = null;
  this.timeout(0);
  console.log('starting countinghouse...');
  child = cp.fork("./framework.js", [
    "--bindAddr",
    "127.0.0.1",
    "--debug",
    "--debugKey",
    "aabbcc",
    "--apiMonitor",
    "--loadModule",
    "./pre-installed-packages/echo-device-module",
    "--loadModule",
    "./pre-installed-packages/echo-device-client-module"
  ], {silent: true});

  // the sub-tests wait for the server's ready line in this (see
  // test/helpers/wait-for-ready.js); captured from the moment of the fork
  child.log = '';
  child.stdout.on('data', (chunk) => { child.log += chunk; });
  child.stderr.on('data', (chunk) => { child.log += chunk; });

  testFiles.forEach((file) => {
    require(`./load-module/${file}`)(child, true);
  });
});


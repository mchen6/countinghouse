var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

var largeBuffer = Buffer.alloc(1024 * 1024 * 20); // 20MB binary data
var req = BSON.serialize({ serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222', binaryData: largeBuffer} });

request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
.set('X-Apemesh-Key', 'aabbcc')
.set('Content-Type', 'application/bson')
.send(req)
.expect('Content-Type', /[json | text]/)
.expect(200, function(err, res) {
  if (err) return;

  if (res.body.output == null
    || res.body.output.binaryData == null
    || res.body.output.binaryData.data == null
  ) {
    console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(BSON.deserialize(req))));
    console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
  }
});


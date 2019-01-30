var should  = require('should');
var request = require('supertest');
var async   = require('async');
var io      = require('socket.io-client');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://192.168.0.15:9527';

var deviceList;


describe('get device list', function() {
  it('get device list OK', function(done) {
    request(url).get('/device-list')
    .expect('Content-Type', /json/)
    .expect(200).end(function(err, res) {
      if(err) throw err;
      for (var i in res.body) {
        res.body[i].should.have.property('configId').which.is.a.Number();
        res.body[i].should.have.property('specVersion').and.have.property('major', 1);
        res.body[i].should.have.property('specVersion').and.have.property('minor', 0);
        res.body[i].should.have.property('device');
        var device = res.body[i].device;
        // device.should.have.property('deviceType');
        device.should.have.property('friendlyName');
        device.should.have.property('manufacturer');
        // device.should.have.property('modelName');
        device.should.have.property('serviceList', {});
        // if (device.deviceType != 'urn:cdif-net:device:BinaryLight:1' &&
        //   device.deviceType != 'urn:cdif-net:device:DimmableLight:1' &&
        //   device.deviceType != 'urn:cdif-net:device:SensorHub:1' &&
        //   device.deviceType != 'urn:cdif-net:device:ONVIFCamera:1') {
        //     throw(new Error('unknown device type: ' + device.deviceType));
        //   }
      }
      deviceList = JSON.parse(JSON.stringify(res.body));
      if (deviceList.find(item => item.device.friendlyName === 'echo-device') === undefined) {
        console.error(chalk.white.bgRed.bold('test case not found, please install echo-device first'));
        throw new Error('test case not found, please install echo-device first');
      }
      done();
    });
  });
});

// describe('connect all devices', function() {
//   this.timeout(0);

//   it('connect OK', function(done) {
//   request(url).get('/device-list')
//   .expect('Content-Type', /json/)
//   .expect(200).end(function(err, res) {
//       if(err) throw err;
//       deviceList = JSON.parse(JSON.stringify(res.body));

//       var cred = {"username": "admin", "password": "test"};
//       async.eachSeries(deviceList, function(deviceObj, callback) {
//         var device   = deviceObj.device;
//         var deviceID = device.deviceID;

//         // if (device.userAuth === true) {
//         //   request(url).post('/devices/' + deviceID + '/connect')
//         //   .send(cred).expect(200, function(err, res) {
//         //     if (err) throw err;
//         //     var device_access_token = res.body.device_access_token;
//         //     deviceList[deviceID].device_access_token = device_access_token;
//         //     callback();
//         //   });
//         // } else {
//         request(url).post('/devices/' + deviceID + '/connect')
//         .expect(200, callback);
//         // }
//       }, done);
//     });
//   });
// });

// describe('subscribe events from all devices', function() {
//   this.timeout(0);
//   var sock = io.connect(url);

//   sock.on('event', function(data) {
//     console.log('socket client received: ' + JSON.stringify(data));
//   });
//   sock.on('error', function(data) {
//     console.log('socket client received error: ' + JSON.stringify(data));
//   });

//   it('subscribe OK', function(done) {
//     async.eachSeries(deviceList, function(deviceObj, callback) {
//       var device   = deviceObj.device;
//       var deviceID = device.deviceID;

//       request(url).get('/devices/' + deviceID + '/get-spec')
//       .send({"device_access_token": deviceList[deviceID].device_access_token})
//       .expect(200, function(err, res) {
//         if (err) throw err;
//         var device = res.body.device;
//         var serviceList = Object.keys(device.serviceList);

//         async.eachSeries(serviceList, function(serviceID, cb) {
//           var room = new Object();
//           room.deviceID  = deviceID;
//           room.serviceID = serviceID;
//           room.device_access_token = deviceList[deviceID].device_access_token;
//           room.onUpdate  = true;
//           sock.emit('subscribe', JSON.stringify(room));
//           cb();
//         }, callback);
//       });
//     }, done);
//   });
// });

describe('test1: invoke all actions', function() {
  this.timeout(0);

  it('invoke OK', function(done) {
    async.eachSeries(deviceList, function(deviceObj, callback) {
      var device   = deviceObj.device;
      var deviceID = device.deviceID;

      request(url).get('/devices/' + deviceID + '/get-spec')
      // .send({"device_access_token": deviceList[deviceID].device_access_token})
      .expect(200, function(err, res) {
        if (err) throw err;
        var device = res.body.device;
        device.should.have.property('serviceList');
        device.serviceList.should.be.an.Object;
        device.serviceList.should.be.not.empty;
        var serviceList = Object.keys(device.serviceList);

        async.eachSeries(serviceList, function(serviceID, cb) {
          testInvokeActions(deviceID, serviceID, res.body.device.serviceList, cb);
        }, callback);
      });
    }, done);
  });
});

describe('test2: unknown deviceID', function() {
  this.timeout(0);
  var req = { serviceID: 'pseudo', actionName: 'pseudo', input: {} };

  it('invoke unknown deviceID', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-f2c1-123456789abc/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('未找到设备') === false) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test unknown deviceID fail'));
      }
      return done();
    });
  });
});

describe('test3: invoke without specifying serviceID', function() {
  this.timeout(0);
  var req = { actionName: 'pseudo', input: {} };

  it('invoke without specifying serviceID', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('未找到serviceID') === false) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test invoke without specifying serviceID fail'));
      }
      return done();
    });
  });
});

describe('test4: invoke with unknown serviceID', function() {
  this.timeout(0);
  var req = { serviceID: 'pseudo', actionName: 'pseudo', input: {} };

  it('invoke with unknown serviceID', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('未知服务') === false) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test invoke with unknown serviceID fail'));
      }
      return done();
    });
  });
});

describe('test5: invoke without specifying actionName', function() {
  this.timeout(0);
  var req = { serviceID: 'pseudo', input: {} };

  it('invoke without specifying actionName', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('未找到actionName') === false) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test invoke without specifying actionName fail'));
      }
      return done();
    });
  });
});

describe('test6: invoke with unknown actionName', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'pseudo', input: {} };

  it('invoke with unknown actionName', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('未找到action') === false) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test invoke with unknown actionName fail'));
      }
      return done();
    });
  });
});

describe('test7: invoke without specifying input', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo' };

  it('invoke without specifying input', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('输入数据校验错误') === false || res.body.fault.reason !== '未找到输入参数') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test invoke without specifying input fail'));
      }
      return done();
    });
  });
});

describe('test8: invoke specify incorrect input type', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: 'input' };

  it('invoke without specifying input', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('输入数据校验错误') === false || res.body.fault.reason !== '数据不是object类型') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test1 invoke specify incorrect input type fail'));
      }
      return done();
    });
  });
});

describe('test9: invoke specify incorrect input type', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: 12345 };

  it('invoke without specifying input', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.message.startsWith('输入数据校验错误') === false || res.body.fault.reason !== '数据不是object类型') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test2 invoke specify incorrect input type fail'));
      }
      return done();
    });
  });
});

describe('test10: invoke specify incorrect input type', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: false };

  it('invoke without specifying input', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('输入数据校验错误') === false || res.body.fault.reason !== '数据不是object类型') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test10 invoke specify incorrect input type fail'));
      }
      return done();
    });
  });
});

describe('test11: invoke specify incorrect input type', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: null };

  it('invoke without specifying input', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('输入数据校验错误') === false || res.body.fault.reason !== '空数据') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test11 invoke specify incorrect input type fail'));
      }
      return done();
    });
  });
});

describe('test12: invoke specify input validation', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: {foo: 111} };

  it('invoke without specifying input', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.message.startsWith('输入数据校验错误') === false
        || res.body.fault.reason !== '数据校验失败'
        || res.body.fault.info.dataPath == null
        || res.body.fault.info.schemaPath == null
        || res.body.fault.info.validatorMessage == null
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test5 invoke specify input validation fail'));
      }
      return done();
    });
  });
});

describe('test13: invoke with timeout', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:timeOutTestService', actionName: 'testTimeout', input: {} };

  it('invoke with timeout', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.message !== '设备无响应') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test13 invoke with timeout fail'));
      }
      return done();
    });
  });
});

describe('test14: invoke error expect fault as an object', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:errorInfoTestService', actionName: 'testErrorInfo', input: {foo: "222"} };

  it('invoke error expect fault as an object', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.message.startsWith('设备调用失败') === false
        || res.body.fault.reason !== 'err'
        || res.body.fault.info !== '222'
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test14 fail: fault is not an object'));
      }
      return done();
    });
  });
});

describe('test15: invoke error expect fault as a string', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:errorInfoTestService', actionName: 'testErrorInfo', input: {foo: "333"} };

  it('invoke error expect fault as a string', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.message.startsWith('设备调用失败') === false
        || res.body.fault !== '333'
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test15 fail: fault is not a string'));
      }
      return done();
    });
  });
});

describe('test16: invoke error expect unknown error', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:errorInfoTestService', actionName: 'testErrorInfo', input: {foo: "444"} };

  it('invoke error expect unknown error', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.message !== '设备调用失败: unknown error'
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test16 fail: not an unknown error'));
      }
      return done();
    });
  });
});


describe('test17: invoke with BSON content-type and JSON text', function() {
  this.timeout(0);
  var req = BSON.serialize({ serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222'} });

  it('invoke with BSON content-type and JSON text', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .set('Content-Type', 'application/bson')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(200, function(err, res) {
      if (err) return done(new Error('test17 fail: ' + err.message));

      return done();
    });
  });
});

describe('test18: invoke with BSON content-type with binary data', function() {
  this.timeout(0);
  var req = BSON.serialize({ serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222', binaryData: Buffer.from('abcdefg')} });

  it('invoke with BSON content-type with binary data', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .set('Content-Type', 'application/bson')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(200, function(err, res) {
      if (err) return done(new Error('test18 fail: ' + err.message));

      if (res.body.output == null
        || res.body.output.binaryData == null
        || res.body.output.binaryData.data == null
        || res.body.output.binaryData.data[0] !== 97
        || res.body.output.binaryData.data[1] !== 98
        || res.body.output.binaryData.data[2] !== 99
        || res.body.output.binaryData.data[3] !== 100
        || res.body.output.binaryData.data[4] !== 101
        || res.body.output.binaryData.data[5] !== 102
        || res.body.output.binaryData.data[6] !== 103
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(BSON.deserialize(req))));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test18 fail'));
      }

      return done();
    });
  });
});

function testInvokeActions(deviceID, serviceID, serviceList, callback) {
  var actionList = serviceList[serviceID].actionList;
  actionList.should.be.an.Object;
  actionList.should.be.not.empty;

  var list = Object.keys(actionList);

  async.eachSeries(list, function(name, cb) {
    //skip testTimeout API which purposely test timeout scenario and was made as an independent test case
    if (serviceID === 'urn:apemesh-com:serviceID:timeOutTestService' && name === 'testTimeout') return cb();
    if (serviceID === 'urn:apemesh-com:serviceID:errorInfoTestService' && name === 'testErrorInfo') return cb();
    if (serviceID === 'urn:example-com:serviceID:errTestService' && name === 'testErrorInfo') return cb();
    if (serviceID === 'urn:apemesh-com:serviceID:db-request') return cb();

    setTimeout(function() {
      var action = actionList[name];
      action.should.be.an.Object;
      action.should.be.not.empty;
      var args = action.argumentList;

      var argList = Object.keys(action.argumentList);
      var req = { serviceID: serviceID,
        actionName: name,
        input: {}
        // device_access_token: deviceList[deviceID].device_access_token
      };
      async.eachSeries(argList, function(arg, call_back) {
        arg.should.not.be.empty;
        var stateVarName = action.argumentList[arg].relatedStateVariable;
        var stateVarTable = serviceList[serviceID].serviceStateTable;
        stateVarTable.should.be.an.Object;
        stateVarTable.should.be.not.empty;
        var stateVar = stateVarTable[stateVarName];
        stateVar.should.be.an.Object;
        stateVar.should.be.not.empty;
        if (stateVar.dataType === 'number'  ||
            stateVar.dataType === 'integer' ||
            stateVar.dataType === 'uint8'   ||
            stateVar.dataType === 'uint16'  ||
            stateVar.dataType === 'uint32'  ||
            stateVar.dataType === 'sint8'   ||
            stateVar.dataType === 'sint16'  ||
            stateVar.dataType === 'sint32') {
          var min = 0; var max = 100;
          if (stateVar.allowedValueRange) {
            stateVar.allowedValueRange.minimum.should.be.a.Number;
            stateVar.allowedValueRange.maximum.should.be.a.Number;
            min = stateVar.allowedValueRange.minimum;
            max = stateVar.allowedValueRange.maximum;
          }
          if (stateVar.defaultValue) {
            req.argumentList[arg] = stateVar.defaultValue;
          } else {
            req.argumentList[arg] = Math.floor(Math.random() * max) + min;
          }
          call_back();
        } else if (stateVar.dataType === 'boolean') {
          req.argumentList[arg] = Math.random() >= 0.5;
          call_back();
        } else if (stateVar.dataType === 'string') {
          if (stateVar.defaultValue) {
            req.argumentList[arg] = stateVar.defaultValue;
          } else {
            req.argumentList[arg] = 'test';
          }
          call_back();
        } else if (stateVar.dataType === 'object') {
          if (arg === 'input') {
            var schemaRef = stateVar.schema;
            schemaRef.should.be.a.String;
            request(url).get('/devices/' + deviceID + '/schema' + encodeURI(schemaRef))
            .expect(200, function(err, res) {
              if (err) throw err;
              var variableSchema = res.body;
              variableSchema.should.be.an.Object;
              variableSchema.should.be.not.empty;
              var fake_data = jsf.generate(variableSchema);
              req.input = fake_data;
              call_back();
            });
          } else {
            call_back();
          }
        }
      }, function() {
        request(url).post('/devices/' + deviceID + '/invoke-action')
        .send(req)
        .expect('Content-Type', /[json | text]/)
        .expect(200, function(err, res) {
          if (err) return cb(err);

          if (deviceID === 'b752c14b-27ec-5374-a2ca-0ce71c247566') {
            if (JSON.stringify(req.input) !== JSON.stringify(res.body.output)) {
              console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
              console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
              return cb(new Error('echo test case failed'));
            }
          }
          cb();
        });
      });
    }, 0);
  }, callback);
}


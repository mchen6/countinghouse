const request = require('supertest');
const async   = require('async');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

const url = 'http://127.0.0.1:9527';

let deviceList;

// small local helpers replacing the should.js assertions this file used to make;
// throw synchronously on failure, same as should.js did
function assertHasProperty(obj, key, expectedValue) {
  if (obj == null || !Object.prototype.hasOwnProperty.call(obj, key)) {
    throw new Error(`expected property: ${key}`);
  }
  if (expectedValue !== undefined && JSON.stringify(obj[key]) !== JSON.stringify(expectedValue)) {
    throw new Error(`expected property ${key} to equal ${JSON.stringify(expectedValue)}, got ${JSON.stringify(obj[key])}`);
  }
}
function assertType(val, type) {
  if (typeof val !== type) throw new Error(`expected type ${type}, got ${typeof val}`);
}
function assertNotEmpty(val) {
  if (val == null) throw new Error('expected non-empty value');
  if (typeof val === 'object' && Object.keys(val).length === 0) throw new Error('expected non-empty object');
  if (typeof val === 'string' && val.length === 0) throw new Error('expected non-empty string');
}


describe('get device list', () => {

  it('get device list OK', (done) => {
    request(url).get('/device-list')
    .expect('Content-Type', /json/)
    .expect(200).end((err, res) => {
      if(err) throw err;
      for (const i in res.body) {
        assertHasProperty(res.body[i], 'device');
        const device = res.body[i].device;
        // assertHasProperty(device, 'deviceType');
        assertHasProperty(device, 'friendlyName');
        assertHasProperty(device, 'manufacturer');
        // assertHasProperty(device, 'modelName');
        assertHasProperty(device, 'serviceList', {});
        // if (device.deviceType != 'urn:countinghouse-net:device:BinaryLight:1' &&
        //   device.deviceType != 'urn:countinghouse-net:device:DimmableLight:1' &&
        //   device.deviceType != 'urn:countinghouse-net:device:SensorHub:1' &&
        //   device.deviceType != 'urn:countinghouse-net:device:ONVIFCamera:1') {
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

  it('invoke OK', (done) => {
    async.eachSeries(deviceList, (deviceObj, callback) => {
      const device   = deviceObj.device;
      const deviceID = device.deviceID;

      request(url)
      .get(`/devices/${deviceID}/get-spec`)
      .set('X-CH-Key', 'aabbcc')
      // .send({"device_access_token": deviceList[deviceID].device_access_token})
      .expect(200, (err, res) => {
        if (err) throw err;
        const device = res.body.device;
        assertHasProperty(device, 'serviceList');
        assertType(device.serviceList, 'object');
        assertNotEmpty(device.serviceList);
        const serviceList = Object.keys(device.serviceList);

        async.eachSeries(serviceList, (serviceID, cb) => {
          testInvokeActions(deviceID, serviceID, res.body.device.serviceList, cb);
        }, callback);
      });
    }, done);
  });
});

function testInvokeActions(deviceID, serviceID, serviceList, callback) {
  const actionList = serviceList[serviceID].actionList;
  if (!Array.isArray(actionList)) throw new Error('actionList must be an array (5.0.0 spec format)');
  assertNotEmpty(actionList);

  async.eachSeries(actionList, (action, cb) => {
    const name = action.name;
    assertType(name, 'string');
    //skip testTimeout API which purposely test timeout scenario and was made as an independent test case
    if (serviceID === 'urn:countinghouse-com:serviceID:timeOutTestService' && name === 'testTimeout') return cb();
    if (serviceID === 'urn:countinghouse-com:serviceID:timeOutTestService' && name === 'testTimeoutAsync') return cb();
    //below tests are expect to fail in this scenario, so skip it
    if (serviceID === 'urn:countinghouse-com:serviceID:errorInfoTestService') return cb();
    if (serviceID === 'urn:example-com:serviceID:errTestService') return cb();
    if (serviceID === 'urn:countinghouse-com:serviceID:db-request') return cb();

    setTimeout(() => {
      const req = { serviceID: serviceID,
        actionName: name,
        input: {}
        // device_access_token: deviceList[deviceID].device_access_token
      };

      // 5.0.0 spec format: the action points straight at its input schema in
      // the module's schema.json -- no state table to walk through, and every
      // argument is a schema document, so there are no scalar cases left.
      function withInput(next) {
        if (action.input == null) return next();
        const schemaRef = action.input.schema;
        assertType(schemaRef, 'string');
        request(url)
        .get(`/devices/${deviceID}/schema${encodeURI(schemaRef)}`)
        .set('X-CH-Key', 'aabbcc')
        .expect(200, (err, res) => {
          if (err) throw err;
          const variableSchema = res.body;
          assertType(variableSchema, 'object');
          assertNotEmpty(variableSchema);
          req.input = jsf.generate(variableSchema);
          next();
        });
      }

      withInput(() => {
        request(url).post(`/devices/${deviceID}/invoke-action`)
        .set('X-CH-Key', 'aabbcc')
        .send(req)
        .expect('Content-Type', /[json | text]/)
        .expect(200, (err, res) => {
          if (err) {
            return cb(err);
          }

          if (deviceID === 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767') {
            if (JSON.stringify(req.input) !== JSON.stringify(res.body.output)) {
              console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
              console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
              return cb(new Error('echo test case failed'));
            }
          }
          cb();
        });
      });
    }, 0);
  }, callback);
}


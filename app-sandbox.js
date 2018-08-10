var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var MessageChannel = require('worker_threads').MessageChannel;
var MessagePort    = require('worker_threads').MessagePort;
var parentPort     = require('worker_threads').parentPort;

var rewire = require('rewire');

var options        = require('./lib/cli-options');
options.setOptions({});

var CdifUtil       = require('./lib/cdif-util');


// if (isMainThread) {
//   const worker = new Worker(__filename);
//   const subChannel = new MessageChannel();
//   worker.postMessage({ hereIsYourPort: subChannel.port1 }, [subChannel.port1]);
//   subChannel.port2.on('message', (value) => {
//     console.log('received:', value);
//   });
// } else {
//   parentPort.once('message', (value) => {
//     assert(value.hereIsYourPort instanceof MessagePort);
//     value.hereIsYourPort.postMessage('the worker is sending this');
//     value.hereIsYourPort.close();
//   });
// }



if (isMainThread) {
  var worker  = new Worker(fileName);
  var channel = new MessageChannel();

  worker.postMessage({input: input});
} else {
  parentPort.once('message', function(value) {
    console.log(value.input);
    return rewire('/home/mchen6/foo-module/service1-API1.js');
  });
}

//TODO: rewire load module file and invoke it

    // parentPort.once('message', function(value) {
    //   console.log(value);
    //   var input   = value.input;

    //   var unsafeDomain = Domain.create();
    //   unsafeDomain.on('error', function(err) {
    //     return session.callback(new DeviceError('DEVICE_INVOKE_EXCEPTION', err.message), null);
    //   });

    //   unsafeDomain.run(function() {
    //     var args = {};
    //     // prepare session and httpHeaders object ref for callee
    //     args.ctx = session;
    //     // for non-local http call req is available in session obj, for local calls req is null, see session creation code in routes/user.js and service-client.js
    //     if (session.req != null) {
    //       args.httpHeaders = session.req.headers;
    //     }

    //     if (options.allowSimpleType !== true) {
    //       // in case simple type is not allowed, the incoming api call must contain 'input' field, see validator.js
    //       args.input = input.input; // this can be either object or array type, but not simple type
    //     } else {
    //       for (var i in input) {
    //         args[i] = input[i];
    //       }
    //     }
    //     action.invoke(args, function(err, output) {
    //       console.log(output);
    //       if (err) {
    //         //TODO: validate the content of fault object according to its optional fault definition in device spec
    //         // API's formal fault definition, which can be in either simple or complex type, would make it more conformant to WSDL
    //         var error = null;
    //         if (err instanceof DeviceError || err instanceof CdifError) {
    //           error = err;
    //         } else {
    //           error = new DeviceError('DEVICE_INVOKE_FAIL', err.message);
    //         }
    //         if (output && output.fault) {
    //           return session.callback(error, output.fault);
    //         }
    //         return session.callback(error, null);
    //       }
    //       _this.validateActionCall(action, output, false, function(error, data) {
    //         if (error) {
    //           if (data && data.fault) {
    //             return session.callback(error, data.fault);
    //           }
    //           return session.callback(error, null);
    //         }
    //         // TODO: there should be no update event emission if hashCode collision occurs
    //         // in this case, collided subscribers won't receive any update message
    //         // we need to detect hash Collision when we do event subscription
    //         _this.updateStateFromAction(action, input, output, function(updated) {
    //           if (options.enableAPICache === true && options.wsServer === true && action.apiCache != null && updated === true) {
    //             var hashString = hashKey.getInputHashKey(_this.device.deviceID, _this.serviceID, action.name, input);

    //             LOG.I('value invalidated');
    //             redisClient.sinter('keyset:' + hashString, 'subset', function(err, results) {
    //               wss.publish(results, hashString, JSON.stringify(output));
    //             });

    //           }
    //         });

    //         session.callback(null, output);
    //       });
    //     });
    //   });



    // });
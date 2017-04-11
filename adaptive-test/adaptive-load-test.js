var request   = require('request');
var async     = require('async');
var WebSocket = require('ws');

var stringHash  = require('string-hash');

var getInputHashKey = function(deviceID, serviceID, actionName, input) {
  var inputKey = deviceID + '#' + serviceID + '#' + actionName + '#' + JSON.stringify(input);
  var hashCode = stringHash(inputKey);
  return hashCode.toString();
};

var noofConcurrentClients = 10000;
var loadSaveFactor = 1;
var workUrl = 'http://10.0.0.122:9527/devices/3a509370-6db9-5fd0-9e98-4a912810d805/invoke-action';

//TODO: randomly choose payload / input key
var payload = {
  serviceID: 'urn:apemesh-com:serviceID:db-request',
  actionName: 'request',
  input: {
    db: 'devices'
  }
};

var worker = function() {

  var options = {
    url: workUrl,
    headers: {
      'Content-Type': 'application/json'
    },
    method: 'POST',
    json: payload
  };

  var key = getInputHashKey('3a509370-6db9-5fd0-9e98-4a912810d805', payload.serviceID, payload.actionName, {input: payload.input});

  if (this.subscribedKeyList[key] == null) {
    request(options, function(err, response, body) {
      this.createWSSubscription(payload.serviceID, payload.actionName, payload);
      return setTimeout(worker.bind(this), 2000); // simulate user behaviour, access the same key after 2 seconds
    }.bind(this));
    //FIXME: do not subscribe the second time before server returns 'subok'
  }

  if (this.subscribedKeyList[key] === false) {
    request(options, function(err, response, body) {
      if (err) return console.error(err);
      //TODO: add null-check to header value
      if (response == null) return console.error('action call response invalid');

      var loadLevel = parseInt(response.headers['cache-control'].substring(8));
      // this means if we send 10 percent of request than original load
      // smaller dividend would result in lighter server load
      // according to our data even when loadSaveFactor = 1, we can still update the server cache in 1 second in local env
      // and this means we can make sure to detect server cache expire in time
      var interval  = Math.floor((loadLevel / loadSaveFactor) * 1000);
      console.log('load: ' + loadLevel);
      // console.log('interval: ' + interval);

      //this random delay is only for test to see how much load we can save for cdif server
      // in real production environment, client side may issue a request nor mor than interval seconds
      // and during that interval, we push updated data to client through websocket
      // this interval, however, should be no longer than 2 minutes no mattter what the server load is IMO
      var randomDelay = Math.floor(Math.random() * interval) * 2; // multiply by 2 to simulate real call frequency
      // console.log('random delay: ' + randomDelay);
      return setTimeout(worker.bind(this), randomDelay);

    }.bind(this));
  }

  if (this.subscribedKeyList[key] === true) {
    setTimeout(function() {
      request(options, function(err, response, body) {
        if (err) return console.error(err);
        //TODO: add null-check to header value
        if (response == null) return console.error('action call response invalid');

        var loadLevel = parseInt(response.headers['cache-control'].substring(8));
        var interval  = Math.floor((loadLevel / loadSaveFactor) * 1000);
        console.log('load: ' + loadLevel);
        // console.log('interval: ' + interval);
        var randomDelay = Math.floor(Math.random() * interval) * 2; // multiply by 2 to simulate real call frequency
        this.subscribedKeyList[key] = false;
        return setTimeout(worker.bind(this), randomDelay);
      }.bind(this));
    }.bind(this), Math.random() * 10000); // simulate user behaviour, if found a key is invalidated, issue call in 10 seconds

  }
};

function WorkerClass() {
  this.ws = new WebSocket('ws://10.0.0.122:9527/devices/3a509370-6db9-5fd0-9e98-4a912810d805/wss', 'apemesh');
  this.ws.on('open', this.onWSOpen.bind(this));
  this.ws.on('message', this.onWSMessage.bind(this));
  this.ws.on('error', this.onWSError.bind(this));
  this.ws.on('close', this.onWSClose.bind(this));
  this.subscribedKeyList = {};
  this.wsOpened = false;
}

WorkerClass.prototype.createWSSubscription = function(serviceID, actionName, payload) {
  var subOptions = {};
  subOptions.topic      = 'subscribe';
  subOptions.serviceID  = serviceID;
  subOptions.actionName = actionName;
  subOptions.input      = {input: payload.input};
  if (this.wsOpened === true) {
    this.ws.send(JSON.stringify(subOptions));
  }
  return this.ws;
};

WorkerClass.prototype.onWSOpen = function() {
  this.wsOpened = true;
};

WorkerClass.prototype.onWSMessage = function(message, flags) {
  if (/^subok/.test(message)) {
    var key = message.substring(6);
    this.subscribedKeyList[key] = false; // false means subok and not invalidated yet
    return;
  }
  if (/^subfail/.test(message)) {
    this.ws.terminate();
  }
  var key = message;

  if (this.subscribedKeyList[key] != null) {
    // console.log('invalidated');
    this.subscribedKeyList[key] = true; // true means invalidated
    worker.bind(this)();   // reissue action call to get latest value
  }
};

WorkerClass.prototype.onWSError = function(error) {
  this.ws.terminate();
  this.wsOpened = false;
};

WorkerClass.prototype.onWSClose = function(code, reason) {
  this.wsOpened = false;
};

var q = async.queue(function (task, callback) {
  var workerObj = new WorkerClass();
  worker.bind(workerObj)();
}, noofConcurrentClients);

for (var i = 0; i < noofConcurrentClients; i++) {
  var name = 'worker ' + i;

  q.push({name: name}, function (err) {
      console.log('finished processing foo');
  });
}




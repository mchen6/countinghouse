var request = require('request');
var async   = require('async');

var noofConcurrentClients = 20000;
var loadSaveFactor = 1;
var workUrl = 'http://10.0.0.122:9527/devices/3a509370-6db9-5fd0-9e98-4a912810d805/invoke-action';

//TODO: randomly choose payload / input key
var payload = {
  serviceID: 'urn:apemesh-com:serviceID:db-request',
  actionName: 'request',
  input: {
    db: 'registry'
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

  request(options, function(err, response, body) {
    // TODO: add null-check to header value
    var loadLevel = parseInt(response.headers['cache-control'].substring(8));
    // this means if we send 10 percent of request than original load
    // smaller dividend would result in lighter server load
    // according to our data even when loadSaveFactor = 1, we can still update the server cache in 1 second in local env
    // and this means we can make sure to detect server cache expire in time
    var interval  = Math.floor((loadLevel / loadSaveFactor) * 1000);
    console.log('load: ' + loadLevel);
    console.log('interval: ' + interval);

    //this random delay is only for test to see how much load we can save for cdif server
    // in real production environment, client side may issue a request nor mor than interval seconds
    // and during that interval, we push updated data to client through websocket
    var randomDelay = Math.floor(Math.random() * interval);
    console.log('random delay: ' + randomDelay);
    setTimeout(worker, randomDelay);
  });
};

var q = async.queue(function (task, callback) {
  worker();
}, noofConcurrentClients);

for (var i = 0; i < noofConcurrentClients; i++) {
  var name = 'worker ' + i;

  q.push({name: name}, function (err) {
      console.log('finished processing foo');
  });
}




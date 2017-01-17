var request = require('request');
var async   = require('async');

var noofConcurrentClients = 1000;
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

  request(options, function(err, response, body) {
    var loadLevel = parseInt(response.headers['cache-control'].slice(8, 11));
    var interval  = Math.floor((loadLevel / 20) * 1000); // this means if we send 10 percent of request than original load
    console.log('load: ' + loadLevel);

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




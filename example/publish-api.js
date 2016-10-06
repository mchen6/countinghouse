var request = require('request');

var verifyOptions = {
  url: 'http://localhost:3049/verify-module',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  },
  method: 'POST',
  json: {
      name: '/home/mchen6/tmp/cdif-weibo-0.0.21.tgz'
  }
};


request(verifyOptions, function(err, response, body) {
  console.log(body.packageInfo);
  var info = body.packageInfo;

  var publishOptions = {
    url: 'http://localhost:3049/publish-module',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    method: 'POST',
    json: {
        username: 'out4b',
        password: 'xsVLX842',
        email: 'seeds.c@gmail.com',
        registry: 'http://localhost:5984/registry/_design/app/_rewrite/',
        name: '/home/mchen6/tmp/cdif-weibo-0.0.21.tgz',
        info: info
    }
  };

  request(publishOptions, function(err, response, body) {
    console.log(err);
    console.log(body);
  });
});


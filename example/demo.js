var https=require('https');

// 这里展示的是发送短信验证码API的input JSON对象的构建方法
// 其他API的input JSON对象参数的构建方法请参照各自的API文档
var body = {
  "serviceID":"urn:cdif-io:serviceID:短信服务",
  "actionName":"发送验证码",
  "input": {
    "phoneNum":"13910000000",
    "templateID":"<模板ID>",
    "content":["211315"]
  }
};

var bodyString = JSON.stringify(body);

var options = {
  host: 'api.apemesh.com',
  port: 3049,
  path: '/devices/f5dc73f9-b739-5ee2-add7-e499da04c6ec/invoke-action',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bodyString),
    'X-Apemesh-Key': '<用户appKey>'
  }
};

var req = https.request(options,function(res) {
  res.setEncoding('utf-8');

    var responseString = '';

    res.on('data', function(data) {
      responseString += data;
    });

    res.on('end', function() {
      var resultObject = JSON.parse(responseString);
      if (resultObject.topic === 'device error') {
        return console.log(resultObject.fault.reason);
      }
      return console.log(resultObject.output.result);
    });

    req.on('error', function(e) {
      // TODO: handle request error
      console.log(e);
  });
});

req.write(bodyString);
req.end();
const Config = require("./config")

function com_lydata_alarm_subscribe(args, callback) {
  let topic = args.input.topic;
  
  if (this.mqttClientConnected !== true) return callback(new Error('mqtt client not connected'));

  this.mqttClient.on('message', function (topic, message) {
    // message is Buffer
    console.log(message.toString());
  });

  this.mqttClient.subscribe(`${topic}/${Config.$APPID}/+`, {
    qos: 1
  }, (err, granted) => {
      if(err) {
        console.error(err);
        return callback(err);
      } else {
        console.log('granted:', granted);
        return callback(null, {output: {result: granted, content:'订阅成功'}});
      }
  });
}

module.exports = com_lydata_alarm_subscribe;
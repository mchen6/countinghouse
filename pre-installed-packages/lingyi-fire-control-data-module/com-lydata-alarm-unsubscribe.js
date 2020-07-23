function com_lydata_alarm_unsubscribe(args, callback) {
  this.mqttClient.unsubscribe(args.input.topic+'/dYpqqGzVBxf6/+', (err) => {
      if(err) {
        console.error(err);
        return callback(err);
      } else {
        return callback(null, {output: {content: "退订成功"}});
      }
  });
}

module.exports = com_lydata_alarm_unsubscribe;
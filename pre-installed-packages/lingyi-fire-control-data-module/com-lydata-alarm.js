var com_lydata_alarm_unsubscribe = CdifUtil.loadFile(__dirname + '/com-lydata-alarm-unsubscribe.js');
var com_lydata_alarm_subscribe = CdifUtil.loadFile(__dirname + '/com-lydata-alarm-subscribe.js');

module.exports = {
  com_lydata_alarm_subscribe: com_lydata_alarm_subscribe,
  com_lydata_alarm_unsubscribe: com_lydata_alarm_unsubscribe
};
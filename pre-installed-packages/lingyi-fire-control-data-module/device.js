var fs = require('fs');
var mqtt = require('./mqtt');
var com_lydata_devices_list = CdifUtil.loadFile(__dirname + '/com-lydata-devices.js').com_lydata_devices_list;
var com_lydata_devices_users = CdifUtil.loadFile(__dirname + '/com-lydata-devices.js').com_lydata_devices_users;
var com_lydata_devices_dict = CdifUtil.loadFile(__dirname + '/com-lydata-devices.js').com_lydata_devices_dict;
var com_lydata_alarm_subscribe = CdifUtil.loadFile(__dirname + '/com-lydata-alarm.js').com_lydata_alarm_subscribe;
var com_lydata_alarm_unsubscribe = CdifUtil.loadFile(__dirname + '/com-lydata-alarm.js').com_lydata_alarm_unsubscribe;
var com_platform_api_getInfo = CdifUtil.loadFile(__dirname + '/com-platform-api.js').com_platform_api_getInfo;
const Config = require('./config');

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CdifDevice.call(this, spec);
  this.setAction('urn:lydata-com:serviceID:devices', 'list', com_lydata_devices_list.bind(this));
  this.setAction('urn:lydata-com:serviceID:devices', 'users', com_lydata_devices_users.bind(this));
  this.setAction('urn:lydata-com:serviceID:devices', 'dict', com_lydata_devices_dict.bind(this));
  this.setAction('urn:lydata-com:serviceID:alarm', 'subscribe', com_lydata_alarm_subscribe.bind(this));
  this.setAction('urn:lydata-com:serviceID:alarm', 'unsubscribe', com_lydata_alarm_unsubscribe.bind(this));
  this.setAction('urn:platform-com:serviceID:api', 'getInfo', com_platform_api_getInfo.bind(this));

  this.mqttClient = mqtt.connect(Config.$MQTTS, {
    username: Config.$USERNAME,
    password: Config.$PASSWORD,
    clientId: `${ Config.$APPID }_${ Config.$USERNAME }_lykj`,
    clean: true
  });
  this.mqttClient.once('connect', function() {

    this.mqttClientConnected = true;
  }.bind(this));
}

CdifUtil.inherits(Device, CdifDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

Device.prototype._getDeviceRootApi = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
};

Device.prototype._destroyDevice = function() {
  this.mqttClient.end(true, function() {});
};

module.exports = Device;

var stringHash      = require('string-hash');
var stableStringify = require('json-stable-stringify');

module.exports = {
  getInputHashKey: function(deviceID, serviceID, actionName, input) {
    var inputKey = deviceID + '#' + serviceID + '#' + actionName + '#' + stableStringify(input);
    var hashCode = stringHash(inputKey);
    return hashCode.toString();
  },
  getInputKeyName: function(deviceID, serviceID, actionName, input) {
    return deviceID + '#' + serviceID + '#' + actionName + '#' + stableStringify(input);
  },
  getInputKeyItems: function(keyString) {
    return keyString.split('#');
  }
};

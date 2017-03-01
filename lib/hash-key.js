var stringHash  = require('string-hash');

module.exports = {
  getInputHashKey: function(deviceID, serviceID, actionName, input) {
    var inputKey = deviceID + '#' + serviceID + '#' + actionName + '#' + JSON.stringify(input);
    var hashCode = stringHash(inputKey);
    return hashCode.toString();
  },
  getInputKeyName: function(deviceID, serviceID, actionName, input) {
    return deviceID + '#' + serviceID + '#' + actionName + '#' + JSON.stringify(input);
  },
  getInputKeyItems: function(keyString) {
    return keyString.split('#');
  }
};

var com_lydata_devices_dict = CdifUtil.loadFile(__dirname + '/com-lydata-devices-dict.js');
var com_lydata_devices_users = CdifUtil.loadFile(__dirname + '/com-lydata-devices-users.js');
var com_lydata_devices_list = CdifUtil.loadFile(__dirname + '/com-lydata-devices-list.js');

module.exports = {
  com_lydata_devices_list: com_lydata_devices_list,
  com_lydata_devices_users: com_lydata_devices_users,
  com_lydata_devices_dict: com_lydata_devices_dict
};
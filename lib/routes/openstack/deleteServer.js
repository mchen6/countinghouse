const express   = require('express');
const Session   = require('../../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {
    const session = new Session(req, res, 'unknown', 'oc_delete_server', 0, null, null, null);

    const token      = req.get('X-Auth-Token');
    const tenantID   = req.params.tenantID;
    const serverID   = req.params.serverID;

    //map to our fixed deviceID, serviceID and actionName and send api request data to this driver module
    const deviceID   = '46932cf8-07f0-501b-9491-120ae4efd2c2';
    const serviceID  = 'urn:10086-cn:serviceID:弹性计算服务';
    const actionName = '云主机删除';

    // build argument object and uniformly use 'input' to identify input argument
    const argumentList = {};
//    argumentList.token = token;
    argumentList.input = {};
    argumentList.input.token = token;
    cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, argumentList, token, session);
  });
  return router;
}

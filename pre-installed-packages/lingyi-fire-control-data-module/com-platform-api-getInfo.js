function com_platform_api_getInfo(args, callback) {
  const serviceList = this._getDeviceRootApi().device.serviceList
  const schema = this._getDeviceRootSchema()
  
  let API_JSON = {}
  let device_UUID = ''
  
  let isDef = (key, sk) => {
    return schema.hasOwnProperty(sk) && key.split("serviceID:")[0] === "urn:lydata-com:"
  }

  let getApi = (k,sk) => {
      let list = schema[sk]
      for (const key in list) {
          list[key].serviceID = k
          list[key].actionName = sk
          list[key].device_UUID = device_UUID
      }
      return list
  } 

  let render = (k,sk) => {
    API_JSON[k] = getApi(k,sk)
  }

  let option = {
    url: 'http://47.96.250.0:9527/device-list',
    headers: {
        'X-Apemesh-Key': '***REDACTED-APPKEY***',
    },
    method: 'GET'
  };
  CdifUtil.request(option, (err, res, body) => {
    if(err) return callback(err);
    console.log(body)
    device_UUID = JSON.parse(body)[0].device.deviceID
    for (const key in serviceList) {
      let sk = serviceList.hasOwnProperty(key) ? key.split("serviceID:")[1] : ''
      if (isDef(key, sk)) {
        render(key,sk)
      }
    }
    return callback(null, { output: { content: API_JSON } });
  });

}

module.exports = com_platform_api_getInfo;
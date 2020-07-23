const qs = require('querystring');
const Login = require(__dirname + '/user-login')
const Config = require(__dirname + "/config")

function com_lydata_devices_list(args, callback) {
  Login().then((token) => {
    let option = {
      url: `${Config.$API}/developer/devices?` + qs.stringify({
        status: args.input.status,
        startTime: args.input.startTime,
        endTime: args.input.endTime,
        sort: args.input.sort,
        pageNo: args.input.pageNo,
        pageSize: args.input.pageSize
      }),
      headers: {
        'token': token,
        'Content-Type': 'application/json'
      },
      method: 'GET'
    };
    CdifUtil.request(option, (err, res, body) => {
      if(err) return callback(err);
      else return callback(null, { output: { result: JSON.parse(body) } });
    });
  }, (err) => {
    return callback(err)
  })
}

module.exports = com_lydata_devices_list;
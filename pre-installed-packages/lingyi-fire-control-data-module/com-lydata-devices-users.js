const qs = require('querystring');
const Login = require(__dirname + '/user-login')
const Config = require(__dirname + "/config")

function com_lydata_devices_users(args, callback) {
  Login().then((token) => {
    let option = {
      url: `${Config.$API}/developer/users?` + qs.stringify({
        userIds: args.input.userIds,
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

module.exports = com_lydata_devices_users;
const Config = require("./config")

module.exports = function() {
  var opts = {
    url: `${Config.$API}/developer/login`,
    method: 'POST',
    json: {
      username: Config.$USERNAME,
      password: Config.$PASSWORD
    }
  };
  return new Promise((resolve,reject)=>{
    CdifUtil.request(opts, function(err, res, body) {
      if (body.code !== 0) reject(new Error(body.message))
      else resolve( body.data.token )
    });
  })
}
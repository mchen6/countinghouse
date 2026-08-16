const util              = require('util');
const events            = require('events');
const querystring       = require('querystring');
const OAuth             = require('oauth').OAuth;
const OAuth2            = require('oauth').OAuth2;
const CHUtil          = require('../countinghouse-util');
const options           = require('../cli-options');

function OAuthDevice(cdifDevice) {
  this.device = cdifDevice;
}

OAuthDevice.prototype.setOAuthAccessToken = function(params, callback) {
  if (this.oauth_version === '1.0') {
    const oauth_verifier = params.oauth_verifier;

    if (oauth_verifier == null) {
      callback(new Error('no valid oauth verifier'));
      return;
    }
    this.oauth.getOAuthAccessToken(
      this.oauth_token,
      this.oauth_token_secret,
      oauth_verifier, (error, oauth_access_token, oauth_access_token_secret, results) => {
        if (error) {
          return callback(new Error(`cannot get oauth access token: ${error.data}`));
        } else {
          this.oauth_access_token        = oauth_access_token;
          this.oauth_access_token_secret = oauth_access_token_secret;
          this.results                   = results;
          return callback(null);
        }
      });
  } else if (this.oauth_version === '2.0') {
    // for oauth 2.0 use 127.0.0.1 instead of real host address
    params.redirect_uri = `${CHUtil.getHostProtocol()}127.0.0.1` + `:${options.port}/callback_url`;
    this.oauth2.getOAuthAccessToken(params.code, params, (error, access_token, refresh_token, results) => {
      if (error) {
        return callback(error);
      } else if (results.error) {
        return callback(new Error(JSON.stringify(results)));
      } else {
        this.oauth2_access_token  = access_token;
        this.oauth2_refresh_token = refresh_token;
        this.results              = results;
        return callback(null);
      }
    });
  } else {
    return callback(new Error('cannot set oauth access token, only oauth 1.0 and 2.0 are supported'));
  }
};

OAuthDevice.prototype.connect = function(user, pass, callback) {
  if (this.oauth_version === '1.0') {
    //TODO: update this after we mount callback url on reverse proxy server
    const requestUrl = `${this.oauth_requestUrl}?oauth_callback=${querystring.escape(`${CHUtil.getHostProtocol() + CHUtil.getHostIp()}:${options.port}/callback_url?deviceID=${this.deviceID}`)}`;
    this.oauth = new OAuth(requestUrl,
                          this.oauth_accessUrl || null,
                          this.apiKey || '',
                          this.apiSecret || '',
                          this.oauth_version,
                          null,
                          this.oauth_signatureMethod || 'HMAC-SHA1',
                          this.oauth_nonceSize || null,
                          this.oauth_customHeaders || null);
    // below fields would be filled by oauth flow
    this.oauth_token               = '';
    this.oauth_token_secret        = '';
    this.oauth_access_token        = '';
    this.oauth_access_token_secret = '';
  } else {
    this.oauth2 = new OAuth2(this.apiKey                || '',
                            this.apiSecret              || '',
                            this.oauth2_baseSite        || '',
                            this.oauth2_authorizePath   || '',
                            this.oauth2_accessTokenPath || '',
                            this.oauth2_customHeaders);
    // below fields would be filled by oauth flow
    this.oauth2_access_token    = '';
    this.oauth2_refresh_token   = '';
    this.oauth2_results         = {};
  }

  let redirectUrl = null;

  if (this.oauth_version === '1.0') {
    if (this.oauth_requestUrl == null) {
      return callback(new Error('request Url not valid'));
    }

    this.oauth.getOAuthRequestToken((error, oauth_token, oauth_token_secret, results) => {
      if (error) {
        return callback(new Error(`connect failed, reason: ${error.message}`));
      }

      this.oauth_token        = oauth_token;
      this.oauth_token_secret = oauth_token_secret;
      this.authorize_redirect_url = this.authorize_redirect_url || '';
      redirectUrl = this.authorize_redirect_url + oauth_token;
      return callback(null, {'href': redirectUrl, 'method': 'GET'});
    });
  } else if (this.oauth_version === '2.0') {
    const authorize_params = {};
    // for oauth 2.0 use 127.0.0.1 instead of real host address
    authorize_params.redirect_uri = `${CHUtil.getHostProtocol()}127.0.0.1` + `:${options.port}/callback_url`;

    // add vendor defined authorize params
    for (const i in this.oauth2_authorize_params) {
      authorize_params[i] = this.oauth2_authorize_params[i];
    }
    // has to use 'state' to bring back deviceID on callback url...
    authorize_params.state = this.deviceID;

    redirectUrl = this.oauth2.getAuthorizeUrl(authorize_params);
    return callback(null, {'href': redirectUrl, 'method': 'GET'});
  } else {
    return callback(new Error('only oauth 1.0 and 2.0 are supported'), null);
  }
};

OAuthDevice.prototype.disconnect = function(callback) {
  // below fields are generated during oauth flow
  if (this.oauth_version === '1.0') {
    this.oauth_token               = '';
    this.oauth_token_secret        = '';
    this.oauth_access_token        = '';
    this.oauth_access_token_secret = '';
    this.results                   = null;
  } else if (this.oauth_version === '2.0') {
    this.oauth2_access_token  = '';
    this.oauth2_refresh_token = '';
    this.oauth2_results       = null;
  }
  callback(null);
};

OAuthDevice.prototype.createOAuthDevice = function() {
  if (this.device.oauth_version === '1.0') {
    this.device.oauth_token               = '';
    this.device.oauth_token_secret        = '';
    this.device.oauth_access_token        = '';
    this.device.oauth_access_token_secret = '';
    this.device.results                   = null;
  } else if (this.device.oauth_version === '2.0') {
    this.device.oauth2_access_token  = '';
    this.device.oauth2_refresh_token = '';
    this.device.oauth2_results       = null;
  }

  this.device.isOAuthDevice        = true;
  this.device._connect             = this.connect.bind(this.device);
  this.device._disconnect          = this.disconnect.bind(this.device);
  this.device._setOAuthAccessToken = this.setOAuthAccessToken.bind(this.device);
};


module.exports = OAuthDevice;

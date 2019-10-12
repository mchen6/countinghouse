const crypto = require('crypto')

const db = { // Here is a fast overview of what your db model should look like
  authorizationCode: {
    authorizationCode: '', // A string that contains the code
    expiresAt: new Date(), // A date when the code expires
    redirectUri: '', // A string of where to redirect to with this code
    client: null, // See the client section
    user: null, // Whatever you want... This is where you can be flexible with the protocol
  },
  client: { // Application wanting to authenticate with this server
    clientId: '', // Unique string representing the client
    clientSecret: '', // Secret of the client; Can be null
    grants: [], // Array of grants that the client can use (ie, `authorization_code`)
    redirectUris: [], // Array of urls the client is allowed to redirect to
  },
  token: {
    accessToken: '', // Access token that the server created
    accessTokenExpiresAt: new Date(), // Date the token expires
    client: null, // Client associated with this token
    user: null, // User associated with this token
  },
}


var generateAccessToken = function(client, user, scope) {
  console.log('aa');
};

var generateRefreshToken = function(client, user, scope) {
  console.log('bb');
};

var generateAuthorizationCode = function(client, user, scope) {
  console.log('cc');

  const seed = crypto.randomBytes(256)
  const code = crypto
    .createHash('sha1')
    .update(seed)
    .digest('hex')

    return code;
};

var getAuthorizationCode = function(authorizationCode) {
  console.log('dd');

  /* this is where we fetch the stored data from the code */
  return new Promise(resolve => {
    resolve(db.authorizationCode)
  });
};

var getClient = function(clientId, clientSecret) {
  console.log('getClient called. clientId: ' + clientId + ' clientSecret: ' + clientSecret);
  db.client = { // Retrieved from the database
    clientId: clientId,
    clientSecret: clientSecret,
    grants: ['authorization_code', 'refresh_token'],
    redirectUris: ['http://localhost:3030/client/app'],
  }
  return new Promise(resolve => {
    resolve(db.client)
  })
};

var saveToken = function(token, client, user) {
  console.log('ee');

  /* This is where you insert the token into the database */
  db.token = {
    accessToken: token.accessToken,
    accessTokenExpiresAt: token.accessTokenExpiresAt,
    refreshToken: token.refreshToken, // NOTE this is only needed if you need refresh tokens down the line
    refreshTokenExpiresAt: token.refreshTokenExpiresAt,
    client: client,
    user: user,
  }
  return new Promise(resolve => resolve(db.token));
};

var saveAuthorizationCode = function(code, client, user) {
  console.log('saveAuthorizationCode called. code: ' + JSON.stringify(code) + ' client: ' + JSON.stringify(client) + ' user: ' + JSON.stringify(user));

  /* This is where you store the access code data into the database */
  db.authorizationCode = {
    authorizationCode: code.authorizationCode,
    expiresAt: code.expiresAt,
    client: client,
    user: user,
  }
  return new Promise(resolve => resolve(Object.assign({
    redirectUri: `${code.redirectUri}`,
  }, db.authorizationCode)))
};

var revokeAuthorizationCode = function(code) {
  console.log('ff');

  /* This is where we delete codes */
  db.authorizationCode = { // DB Delete in this in memory example :)
    authorizationCode: '', // A string that contains the code
    expiresAt: new Date(), // A date when the code expires
    redirectUri: '', // A string of where to redirect to with this code
    client: null, // See the client section
    user: null, // Whatever you want... This is where you can be flexible with the protocol
  }
  const codeWasFoundAndDeleted = true  // Return true if code found and deleted, false otherwise
  return new Promise(resolve => resolve(codeWasFoundAndDeleted))
};

var validateScope = function(user, client, scope) {
  console.log('gg');
  /* This is where we check to make sure the client has access to this scope */
  // here we always return true
  const userHasAccess = true;  // return true if this user / client combo has access to this resource

  return new Promise(resolve => resolve(userHasAccess));
};

var getAccessToken = function(token) {
  console.log('hh');
  if (!token || token === 'undefined') return false
  return new Promise(resolve => resolve(db.token))
};

module.exports = {
  getClient: getClient,
  saveToken: saveToken,
  getAuthorizationCode: getAuthorizationCode,
  revokeAuthorizationCode: revokeAuthorizationCode,
//  generateAccessToken: generateAccessToken,
  saveAuthorizationCode: saveAuthorizationCode,
//  generateRefreshToken: generateRefreshToken,
//  generateAuthorizationCode: generateAuthorizationCode,
  validateScope: validateScope,
  getAccessToken: getAccessToken
};


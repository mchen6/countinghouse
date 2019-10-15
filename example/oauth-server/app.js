var express = require('express'),
        bodyParser = require('body-parser'),
        OAuth2Server = require('oauth2-server'),
        Request = OAuth2Server.Request,
        Response = OAuth2Server.Response;

var app = express();

app.use(bodyParser.urlencoded({ extended: true }));

app.use(bodyParser.json());

app.oauth = new OAuth2Server({
        model: require('./model.js'),
        grants: ['authorization_code', 'refresh_token'],
        accessTokenLifetime: 60 * 60 * 24,
        allowBearerTokensInQueryString: true,
        allowExtendedTokenAttributes: true,
        allowEmptyState: true
});

app.post('/token', function(req, res) {
  var request = new Request(req);
  var response = new Response(res);

  return app.oauth.token(request, response)
    .then(function(token) {
      res.json(token);
    }).catch(function(err) {
      res.status(err.code || 500).json(err);
    });
});




app.post('/authorize', function(req, res) {
  var request = new Request(req);
  var response = new Response(res);

  // skip user validation here, and assign user object for any username and password
  var username = req.body.username;
  var password = req.body.password;
  req.body.user = {user: 1};

  return app.oauth.authorize(request, response, { authenticateHandler: {
      handle: function(request, response) {
        return req.body.user;
      }
    }
  })
  .then(function(success) {
      res.json(success)
  }).catch(function(err){
    res.status(err.code || 500).json(err)
  });
});


app.get('/', function(req, res) {

  var request = new Request(req);
  var response = new Response(res);

  return app.oauth.authenticate(request, response)
    .then(function(success) {
      res.send('Congratulations, you are in a secret area!');
    }).catch(function(err) {
      res.status(err.code || 500).json(err);
    });


});

app.listen(3000);

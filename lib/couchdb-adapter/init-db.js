#!/usr/bin/env node
// Creates the `_users` db (if missing) and installs the `_design/user`
// design document + `byAppKeyWithBasicInfo` view that
// couchdb-auth-provider.js queries, on a fresh CouchDB instance. Written
// from scratch against the documented query contract this repo has
// always relied on (key: apiKey, value: [userName, balance, devices]) --
// there was never a copy of the original design document's real map
// function in this repo (or any write path to CouchDB at all), so this
// is a new implementation of the same contract, not a port of anything
// from a private registry/repo.
//
// Usage: node lib/couchdb-adapter/init-db.js [--dbUrl <url>]
//
// User documents are expected to look like:
//   {"type": "user", "appKey": "...", "userName": "...", "balance": 0,
//    "devices": [{"deviceID": "...", "priceRecord": {}}, ...]}
// devices may also contain {"deviceID": "*"} for wildcard access -- an
// addition couchdb-auth-provider.js supports for consistency with
// FileAuthProvider/SqliteAuthProvider; the original schema had no such
// concept, and a document without it works exactly as before.
var nano;
try {
  nano = require('nano');
} catch (e) {
  console.error('This script requires the "nano" package, which is not installed. Run: npm install nano');
  process.exit(1);
}

function parseArgs(argv) {
  var dbUrl = 'http://admin:12345678@127.0.0.1:5984';
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--dbUrl') dbUrl = argv[++i];
  }
  return {dbUrl: dbUrl};
}

// map's source is transmitted to CouchDB as a string (via
// Function.prototype.toString below) and run there, not in this process
// -- `emit` is a CouchDB view-server global, not a real function here.
//
// Deliberately an anonymous function *expression*, not a named function
// declaration -- verified live against a real CouchDB 3.5.2 instance
// (this path had never been exercised against one before) that a named
// declaration's .toString() output ("function byAppKeyWithBasicInfoMap(doc)
// {...}") fails CouchDB's map-function compilation with "Expression does
// not eval to a function", while the exact same body as an anonymous
// expression ("function(doc) {...}") compiles and queries correctly.
// CouchDB's query server evaluates the map source as an expression, and a
// named function *declaration* is a statement, not an expression, in that
// context -- the variable name here is just for readability in this file,
// it never reaches CouchDB.
var byAppKeyWithBasicInfoMap = function(doc) {
  if (doc.type === 'user' && doc.appKey != null) {
    emit(doc.appKey, [doc.userName, doc.balance, doc.devices]);
  }
};

var DESIGN_DOC = {
  _id: '_design/user',
  views: {
    byAppKeyWithBasicInfo: {
      map: byAppKeyWithBasicInfoMap.toString()
    }
  }
};

function main() {
  var opts = parseArgs(process.argv.slice(2));
  var server = nano(opts.dbUrl);

  server.db.create('_users', function(err) {
    // 412 = db already exists -- not an error for this idempotent setup script.
    if (err && err.statusCode !== 412) {
      console.error('failed to create _users db: ' + err.message);
      process.exit(1);
    }

    var usersDB = nano(opts.dbUrl).db.use('_users');

    usersDB.get('_design/user', function(getErr, existing) {
      var doc = JSON.parse(JSON.stringify(DESIGN_DOC));
      // update the design doc in place if it already exists, rather than
      // failing on a rev conflict -- makes this script safely re-runnable.
      if (getErr == null && existing != null) doc._rev = existing._rev;

      usersDB.insert(doc, function(insertErr) {
        if (insertErr) {
          console.error('failed to write _design/user: ' + insertErr.message);
          process.exit(1);
        }
        console.log('ok: _users db ready, _design/user/byAppKeyWithBasicInfo view installed at ' + opts.dbUrl);
      });
    });
  });
}

main();

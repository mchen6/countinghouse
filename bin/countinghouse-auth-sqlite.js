#!/usr/bin/env node
// Minimal CLI for managing lib/auth/sqlite-provider.js's db file at rest
// (add/remove users and their device grants) -- deliberately not an HTTP
// admin endpoint (see sqlite-provider.js's header comment for why).
//
// Usage:
//   node bin/countinghouse-auth-sqlite.js [--dbPath <path>] <command> [args...]
//
// Commands:
//   add-user <apiKey> <userName>              create or rename a user
//   remove-user <apiKey>                       delete a user and all its device grants
//   grant <apiKey> <deviceID>                  authorize apiKey for deviceID (or "*" for every device)
//   revoke <apiKey> <deviceID>                 remove one device grant
//   set-admin <apiKey> <true|false>            grant/revoke admin rights (module-lifecycle routes; independent of device grants)
//   list                                       print every user, their admin status, and their granted devices
//
// --dbPath defaults to ./auth.sqlite3 (same default SqliteAuthProvider itself uses).
var sqlite3 = require('sqlite3');

function parseArgs(argv) {
  var dbPath = process.cwd() + '/auth.sqlite3';
  var rest = [];

  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--dbPath') {
      dbPath = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  return {dbPath: dbPath, args: rest};
}

function usageAndExit(code) {
  console.error('Usage: node bin/countinghouse-auth-sqlite.js [--dbPath <path>] <add-user|remove-user|grant|revoke|set-admin|list> [args...]');
  process.exit(code);
}

function main() {
  var parsed  = parseArgs(process.argv.slice(2));
  var command = parsed.args[0];

  if (command == null) usageAndExit(1);

  var db = new sqlite3.Database(parsed.dbPath);
  db.serialize(function() {
    db.run('CREATE TABLE IF NOT EXISTS users (apiKey TEXT PRIMARY KEY, userName TEXT, admin INTEGER DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS user_devices (apiKey TEXT NOT NULL, deviceID TEXT NOT NULL, PRIMARY KEY (apiKey, deviceID))');
    // Same migration as lib/auth/sqlite-provider.js's _ensureSchema -- this
    // CLI can run against a pre-existing db file independently of the
    // server, so it needs the same unconditional-ALTER-and-swallow-the-
    // duplicate-column-error approach, for the same reason (stays inside
    // this db.serialize() queue, ahead of any command below).
    db.run('ALTER TABLE users ADD COLUMN admin INTEGER DEFAULT 0', function(err) {
      if (err != null && !/duplicate column name/i.test(err.message)) {
        console.error('failed to migrate admin column: ' + err.message);
      }
    });

    switch (command) {
      case 'add-user': {
        var apiKey = parsed.args[1], userName = parsed.args[2];
        if (apiKey == null || userName == null) usageAndExit(1);
        db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?) ON CONFLICT(apiKey) DO UPDATE SET userName = excluded.userName', [apiKey, userName], function(err) {
          if (err) { console.error(err.message); process.exit(1); }
          console.log('ok: ' + apiKey + ' -> ' + userName);
          db.close();
        });
        break;
      }
      case 'remove-user': {
        var apiKey = parsed.args[1];
        if (apiKey == null) usageAndExit(1);
        db.run('DELETE FROM user_devices WHERE apiKey = ?', [apiKey], function(err) {
          if (err) { console.error(err.message); process.exit(1); }
          db.run('DELETE FROM users WHERE apiKey = ?', [apiKey], function(err) {
            if (err) { console.error(err.message); process.exit(1); }
            console.log('ok: removed ' + apiKey);
            db.close();
          });
        });
        break;
      }
      case 'grant': {
        var apiKey = parsed.args[1], deviceID = parsed.args[2];
        if (apiKey == null || deviceID == null) usageAndExit(1);
        db.run('INSERT OR IGNORE INTO user_devices (apiKey, deviceID) VALUES (?, ?)', [apiKey, deviceID], function(err) {
          if (err) { console.error(err.message); process.exit(1); }
          console.log('ok: granted ' + apiKey + ' -> ' + deviceID);
          db.close();
        });
        break;
      }
      case 'revoke': {
        var apiKey = parsed.args[1], deviceID = parsed.args[2];
        if (apiKey == null || deviceID == null) usageAndExit(1);
        db.run('DELETE FROM user_devices WHERE apiKey = ? AND deviceID = ?', [apiKey, deviceID], function(err) {
          if (err) { console.error(err.message); process.exit(1); }
          console.log('ok: revoked ' + apiKey + ' -> ' + deviceID);
          db.close();
        });
        break;
      }
      case 'set-admin': {
        var apiKey = parsed.args[1], flag = parsed.args[2];
        if (apiKey == null || (flag !== 'true' && flag !== 'false')) usageAndExit(1);
        var adminValue = (flag === 'true') ? 1 : 0;
        db.run('UPDATE users SET admin = ? WHERE apiKey = ?', [adminValue, apiKey], function(err) {
          if (err) { console.error(err.message); process.exit(1); }
          if (this.changes === 0) { console.error('no such user: ' + apiKey + ' (add-user first)'); process.exit(1); }
          console.log('ok: ' + apiKey + ' admin -> ' + flag);
          db.close();
        });
        break;
      }
      case 'list': {
        db.all('SELECT apiKey, userName, admin FROM users', [], function(err, users) {
          if (err) { console.error(err.message); process.exit(1); }
          if (users.length === 0) { console.log('(no users)'); db.close(); return; }

          var remaining = users.length;
          users.forEach(function(u) {
            db.all('SELECT deviceID FROM user_devices WHERE apiKey = ?', [u.apiKey], function(err, rows) {
              if (err) { console.error(err.message); process.exit(1); }
              var adminLabel = (u.admin === 1) ? ', admin' : '';
              console.log(u.apiKey + ' (' + u.userName + adminLabel + '): ' + rows.map(function(r) { return r.deviceID; }).join(', '));
              remaining--;
              if (remaining === 0) db.close();
            });
          });
        });
        break;
      }
      default:
        usageAndExit(1);
    }
  });
}

main();

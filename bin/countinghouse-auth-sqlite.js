#!/usr/bin/env node
'use strict';
// Minimal CLI for managing lib/auth/sqlite-provider.js's db file at rest
// (add/remove users and their device grants) -- deliberately not an HTTP
// admin endpoint (see sqlite-provider.js's header comment for why).
//
// Usage:
//   node bin/countinghouse-auth-sqlite.js [--dbPath <path>] <command> [args...]
//
// Commands:
//   add-user <userName>              create or rename the user of the key on stdin
//   remove-user                      delete that user, all its device grants and its module bindings
//   grant <deviceID>                 authorize that key for deviceID (or "*" for every device)
//   revoke <deviceID>                remove one device grant
//   set-admin <true|false>           grant/revoke admin rights (module-lifecycle routes; independent of device grants)
//   set-id <id>                      the stable id behind the user's opaque id
//   bind-module <moduleName>         the identity a module's inner hops authorize as (its package name; the
//                                    sqlite form of runsModules); one identity per module
//   unbind-module <moduleName>       remove a module's binding (no key)
//   list                             print every user by name and id, their admin status, granted devices and
//                                    bound modules (no key)
//
// The key a command is about is read from stdin, never from an argument (it
// would sit in the shell history and the process list): the first line
// piped in (printf '%s\n' "$KEY" | node bin/countinghouse-auth-sqlite.js
// add-user alice), or, at a terminal, typed at a prompt that does not show
// it. Nothing this CLI prints holds a key. The database holds keys in the
// clear: it is created owner-only (0600) and refused when it is not this
// user's own and owner-only (lib/auth/private-store.js; B-meter-keys 4r).
//
// --dbPath defaults to ./auth.sqlite3 (same default SqliteAuthProvider itself uses).
// sqlite3 is an optionalDependency, required lazily -- see
// lib/optional-sqlite3.js. This CLI is unusable without it by definition,
// so report the reason and the ways out instead of a native-loader stack.
let sqlite3;
try {
  sqlite3 = require('../lib/optional-sqlite3').requireSqlite3(
    'bin/countinghouse-auth-sqlite.js (the sqlite AuthProvider CLI)',
    'use --authProvider file and edit auth.json directly; see docs/authentication.md'
  );
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

function parseArgs(argv) {
  let dbPath = `${process.cwd()}/auth.sqlite3`;
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dbPath') {
      dbPath = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  return {dbPath: dbPath, args: rest};
}

function usageAndExit(code) {
  console.error('Usage: node bin/countinghouse-auth-sqlite.js [--dbPath <path>] <add-user|remove-user|grant|revoke|set-admin|set-id|bind-module|unbind-module|list> [args...]\n' +
    '       (a command about a user reads its API key from stdin, never from an argument)');
  process.exit(code);
}

// the commands about a user, and how many arguments each takes beside the
// key (which is read from stdin)
const KEYED = {'add-user': 1, 'remove-user': 0, 'grant': 1, 'revoke': 1, 'set-admin': 1, 'set-id': 1, 'bind-module': 1};

// The key, from stdin: at a terminal, typed at a prompt that does not show
// it; else the first line piped in. -> callback(key); exits on none.
function readKey(callback) {
  const done = (text) => {
    const key = String(text).split(/\r?\n/)[0].trim();
    if (key === '') { console.error('no API key on stdin: pipe it in (printf \'%s\\n\' "$KEY" | ...), or type it at the prompt'); process.exit(1); }
    callback(key);
  };
  if (process.stdin.isTTY) {
    process.stderr.write('API key (input hidden): ');
    process.stdin.setRawMode(true);
    let typed = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(chunk) {
      for (const c of chunk) {
        if (c === '\u0003') { process.stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          process.stderr.write('\n');
          return done(typed);
        }
        if (c === '\u007f' || c === '\b') typed = typed.slice(0, -1);
        else typed += c;
      }
    });
    return;
  }
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { if (text.length < 64 * 1024) text += c; });
  process.stdin.on('end', () => done(text));
}

function main() {
  const parsed  = parseArgs(process.argv.slice(2));
  const command = parsed.args[0];

  if (command == null) usageAndExit(1);
  // (a command about a user: its arguments, the key aside, then the key)
  if (Object.prototype.hasOwnProperty.call(KEYED, command)) {
    if (parsed.args.length !== 1 + KEYED[command]) usageAndExit(1);
    return readKey((key) => run(parsed, command, key));
  }
  return run(parsed, command, null);
}

function run(parsed, command, key) {
  // The database is created owner-only (0600), and refused when it is not
  // this user's own and owner-only: it holds every key. Not for SQLite's
  // in-memory and URI names, which are no file.
  const problem = require('../lib/auth/private-store').preparedStore(parsed.dbPath, 'the sqlite auth database');
  if (problem != null) { console.error(problem); process.exit(1); }
  const db = new sqlite3.Database(parsed.dbPath);
  // Who a key is, for an ok line: its user name, never the key itself.
  const named = (apiKey, cb) => db.get('SELECT userName FROM users WHERE apiKey = ?', [apiKey], (err, row) => {
    if (err) { console.error(err.message); process.exit(1); }
    return cb((row != null && row.userName != null) ? `user ${row.userName}` : 'an unknown user');
  });
  db.serialize(() => {
    db.run('CREATE TABLE IF NOT EXISTS users (apiKey TEXT PRIMARY KEY, userName TEXT, admin INTEGER DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS user_devices (apiKey TEXT NOT NULL, deviceID TEXT NOT NULL, PRIMARY KEY (apiKey, deviceID))');
    // Same migration as lib/auth/sqlite-provider.js's _ensureSchema -- this
    // CLI can run against a pre-existing db file independently of the
    // server, so it needs the same unconditional-ALTER-and-swallow-the-
    // duplicate-column-error approach, for the same reason (stays inside
    // this db.serialize() queue, ahead of any command below).
    db.run('ALTER TABLE users ADD COLUMN admin INTEGER DEFAULT 0', (err) => {
      if (err != null && !/duplicate column name/i.test(err.message)) {
        console.error(`failed to migrate admin column: ${err.message}`);
      }
    });
    // The module bindings (lib/auth/sqlite-provider.js creates the same
    // table on open), for a database from before it.
    db.run('CREATE TABLE IF NOT EXISTS module_identities (moduleName TEXT PRIMARY KEY, apiKey TEXT NOT NULL)');

    switch (command) {
      case 'add-user': {
        const apiKey = key, userName = parsed.args[1];
        db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?) ON CONFLICT(apiKey) DO UPDATE SET userName = excluded.userName', [apiKey, userName], (err) => {
          if (err) { console.error(err.message); process.exit(1); }
          console.log(`ok: user ${userName} added`);
          db.close();
        });
        break;
      }
      case 'remove-user': {
        const apiKey = key;
        named(apiKey, (who) => {
          // grants, then module bindings (a removed key runs no module), then
          // the user; the ok line once all three are gone
          db.run('DELETE FROM user_devices WHERE apiKey = ?', [apiKey], (err) => {
            if (err) { console.error(err.message); process.exit(1); }
            db.run('DELETE FROM module_identities WHERE apiKey = ?', [apiKey], (errM) => {
              if (errM) { console.error(errM.message); process.exit(1); }
              db.run('DELETE FROM users WHERE apiKey = ?', [apiKey], (errU) => {
                if (errU) { console.error(errU.message); process.exit(1); }
                console.log(`ok: removed ${who}, with its grants and module bindings`);
                db.close();
              });
            });
          });
        });
        break;
      }
      case 'grant': {
        const apiKey = key, deviceID = parsed.args[1];
        db.run('INSERT OR IGNORE INTO user_devices (apiKey, deviceID) VALUES (?, ?)', [apiKey, deviceID], (err) => {
          if (err) { console.error(err.message); process.exit(1); }
          named(apiKey, (who) => { console.log(`ok: granted ${who} -> ${deviceID}`); db.close(); });
        });
        break;
      }
      case 'revoke': {
        const apiKey = key, deviceID = parsed.args[1];
        db.run('DELETE FROM user_devices WHERE apiKey = ? AND deviceID = ?', [apiKey, deviceID], (err) => {
          if (err) { console.error(err.message); process.exit(1); }
          named(apiKey, (who) => { console.log(`ok: revoked ${who} -> ${deviceID}`); db.close(); });
        });
        break;
      }
      case 'set-admin': {
        const apiKey = key, flag = parsed.args[1];
        if (flag !== 'true' && flag !== 'false') usageAndExit(1);
        const adminValue = (flag === 'true') ? 1 : 0;
        db.run('UPDATE users SET admin = ? WHERE apiKey = ?', [adminValue, apiKey], function(err) {
          if (err) { console.error(err.message); process.exit(1); }
          if (this.changes === 0) { console.error('no such user (add-user first)'); process.exit(1); }
          named(apiKey, (who) => { console.log(`ok: ${who} admin -> ${flag}`); db.close(); });
        });
        break;
      }
      // The stable id behind the user's opaque id (lib/identity.js): keeps the
      // user's id across a key rotation. 1-128 printable characters, unique.
      case 'set-id': {
        const apiKey = key, id = parsed.args[1];
        if (!/^[\x20-\x7e]{1,128}$/.test(id)) { console.error('id must be 1 to 128 printable characters'); process.exit(1); }
        // The column and its unique index, for a database from before them
        // (the same migration the provider runs on open).
        db.run('ALTER TABLE users ADD COLUMN id TEXT', (e1) => {
          if (e1 && !/duplicate column/i.test(e1.message)) { console.error(e1.message); process.exit(1); }
          db.run('CREATE UNIQUE INDEX IF NOT EXISTS users_id ON users (id) WHERE id IS NOT NULL', (e2) => {
            if (e2) { console.error(e2.message); process.exit(1); }
            db.run('UPDATE users SET id = ? WHERE apiKey = ?', [id, apiKey], function(err) {
              if (err) {
                console.error(/UNIQUE|constraint/i.test(err.message) ? 'that id is already set on another user; every id must be unique' : err.message);
                process.exit(1);
              }
              if (this.changes === 0) { console.error('no such user (add-user first)'); process.exit(1); }
              named(apiKey, (who) => { console.log(`ok: id set for ${who}`); db.close(); });
            });
          });
        });
        break;
      }
      // R2-1 Task 5 (#147): a module's binding, by the module name the
      // server loads it under (its package.json name). One identity per
      // module: binding again moves it. The user must exist; the error does
      // not echo the key.
      case 'bind-module': {
        const apiKey = key, moduleName = parsed.args[1];
        if (moduleName.trim() === '') { console.error('the module name must not be empty'); process.exit(1); }
        db.get('SELECT 1 AS found FROM users WHERE apiKey = ?', [apiKey], (err, row) => {
          if (err) { console.error(err.message); process.exit(1); }
          if (row == null) { console.error('no such user (add-user first)'); process.exit(1); }
          db.get('SELECT apiKey FROM module_identities WHERE moduleName = ?', [moduleName], (errP, prev) => {
            if (errP) { console.error(errP.message); process.exit(1); }
            db.run('INSERT INTO module_identities (moduleName, apiKey) VALUES (?, ?) ON CONFLICT(moduleName) DO UPDATE SET apiKey = excluded.apiKey',
              [moduleName, apiKey], (err2) => {
                if (err2) { console.error(err2.message); process.exit(1); }
                named(apiKey, (who) => {
                  if (prev == null || prev.apiKey === apiKey) {
                    console.log(`ok: module ${moduleName} runs as ${who} (from its next load or reload)`);
                    return db.close();
                  }
                  named(prev.apiKey, (was) => {
                    console.log(`ok: module ${moduleName} moved from ${was} to ${who} (from its next load or reload)`);
                    db.close();
                  });
                });
              });
          });
        });
        break;
      }
      case 'unbind-module': {
        const moduleName = parsed.args[1];
        if (moduleName == null) usageAndExit(1);
        if (moduleName.trim() === '') { console.error('the module name must not be empty'); process.exit(1); }
        db.run('DELETE FROM module_identities WHERE moduleName = ?', [moduleName], function(err) {
          if (err) { console.error(err.message); process.exit(1); }
          if (this.changes === 0) { console.error(`no binding for module ${moduleName}`); process.exit(1); }
          console.log(`ok: module ${moduleName} unbound (from its next load or reload)`);
          db.close();
        });
        break;
      }
      // every user by name and id, never its key
      case 'list': {
        db.all('SELECT * FROM users', [], (err, users) => {
          if (err) { console.error(err.message); process.exit(1); }
          if (users.length === 0) { console.log('(no users)'); db.close(); return; }

          let remaining = users.length;
          users.forEach((u) => {
            db.all('SELECT deviceID FROM user_devices WHERE apiKey = ?', [u.apiKey], (err, rows) => {
              if (err) { console.error(err.message); process.exit(1); }
              db.all('SELECT moduleName FROM module_identities WHERE apiKey = ? ORDER BY moduleName', [u.apiKey], (err2, mods) => {
                if (err2) { console.error(err2.message); process.exit(1); }
                const adminLabel = (u.admin === 1) ? ', admin' : '';
                const runs = (mods.length > 0) ? `; runs modules: ${mods.map((m) => m.moduleName).join(', ')}` : '';
                console.log(`${u.userName != null ? u.userName : '(no name)'} (id ${u.id != null ? u.id : '-'}${adminLabel}): ${rows.map((r) => r.deviceID).join(', ')}${runs}`);
                remaining--;
                if (remaining === 0) db.close();
              });
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

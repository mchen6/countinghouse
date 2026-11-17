// The start line's options (framework.js "start with options:"), reviewer,
// 2026-11-13, from a dogfooding log: it showed CDIF-era settings a local
// install never uses, and the default --dbUrl with its password. The line is
// getOptionsForLog(): --dbUrl only under --authProvider couchdb, and no
// credential in any URL. The settings read nowhere (--wetty,
// --centralPortalUrl, --verifyModule, --apiMonitor) are gone altogether, as is
// --logStream, which changed nothing (both of the logger's branches were one).
// Server-free, except one spawned stdio start that checks the line itself.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {mkdtemp, remove} = require('../helpers/test-tmp');
const cli = require('../../lib/cli-options');

describe('validation 13: the start line\'s options', () => {
  afterEach(() => cli.setOptions({workerThread: false}));

  it('leaves out --dbUrl where nothing reads it, and has none of the retired settings', () => {
    cli.setOptions({workerThread: false});
    const o = cli.getOptionsForLog();
    for (const k of ['wetty', 'centralPortalUrl', 'verifyModule', 'apiMonitor', 'logStream', 'dbUrl']) assert.ok(!(k in o), k);
    assert.strictEqual(o.workerThread, false, 'the rest is there');
  });

  it('takes --logStream as no option at all (it changed nothing), and no boolean flag of that name', () => {
    cli.setOptions({workerThread: false, logStream: true});
    assert.ok(!('logStream' in cli), 'not an option');
    assert.ok(!('logStream' in cli.getOptions()), 'not passed to a worker');
    assert.ok(!cli.BOOLEAN_FLAGS.includes('logStream'));
  });

  it('keeps --dbUrl under couchdb, without credentials', () => {
    const secret = `pw${'X'.repeat(8)}`;
    cli.setOptions({workerThread: false, debug: true, authProvider: 'couchdb', dbUrl: `http://admin:${secret}@127.0.0.1:5984`,
      redisUrl: `redis://user:${secret}@127.0.0.1:9749`});
    const o = cli.getOptionsForLog();
    assert.ok('dbUrl' in o);
    assert.ok(!JSON.stringify(o).includes(secret), JSON.stringify({dbUrl: o.dbUrl, redisUrl: o.redisUrl}));
    assert.match(o.dbUrl, /127\.0\.0\.1:5984/);
    assert.match(o.redisUrl, /127\.0\.0\.1:9749/);
  });

  // The map is announced on its own lines once it is in effect (framework.js,
  // "remote origin mapped: ... (acceptance only)"); the start line, logged
  // first, does not repeat it.
  it('leaves out --remoteOriginMap: it has its own lines once in effect', () => {
    cli.setOptions({workerThread: false, remoteOriginMap: 'https://origin-13.invalid=http://127.0.0.1:9741'});
    assert.ok(cli.remoteOriginMapArg != null, 'the option was read');
    const o = cli.getOptionsForLog();
    assert.ok(!Object.keys(o).some((k) => /remoteOriginMap/.test(k)), Object.keys(o).join(', '));
    assert.ok(!JSON.stringify(o).includes('origin-13.invalid'));
  });

  it('the line a start logs holds none of them, and no default password', function() {
    this.timeout(60000);
    const home = mkdtemp('validation-13-');
    try {
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'countinghouse-stdio.js'), '--workerThread', '--store', 'local',
        '--storePath', path.join(home, 'store'), '--moduleDataPath', path.join(home, 'md'), '--modulePath', path.join(home, 'modules')],
      {input: '', encoding: 'utf8', timeout: 30000});
      const line = r.stderr.split('\n').find((l) => l.includes('start with options:'));
      assert.ok(line != null, r.stderr.slice(-1500));
      for (const s of ['wetty', 'centralPortalUrl', 'dbUrl', '5984', 'api.countinghouse.com']) assert.ok(!line.includes(s), s);
      assert.ok(!/DEP0176|fs\.W_OK is deprecated/.test(r.stderr), 'no fs.W_OK deprecation warning');
    } finally {
      remove(home);
    }
  });
});

'use strict';
// R-undo-latched (walk finding 6): a client whose first frame says "no" (any
// hook in its configuration, or settings it can't read) latches its session,
// and a session's own lowering is still undone in conversation, with no
// form. Spawned as ch-local daemon spawns the shared runtime, with its
// settings file; release 1's tested-client list (empty: no form is ever
// shown).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {runtime, listening, request, shim} = require('./helpers/per-session');
// (under os.tmpdir(): the socket's path is short there)
const trees = require('../helpers/test-tmp').forFile(['ch-sr16-'], {base: os.tmpdir()});

describe('session-runtime 16: a latched session\'s own lowering, undone', function() {
  this.timeout(120000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let r = null;
  after(async () => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
  });

  it('client frame "no" at connect: lowered, undone, told and recorded; above the value for all sessions refused as before', async () => {
    const home = trees.mkdtemp('ch-sr16-');
    const settingsFile = path.join(home, 'settings.json');
    r = runtime(home, ['--settingsFile', settingsFile]);
    const secret = await listening(r);
    assert.ok(secret != null, r.log().slice(-2000));
    const no = {status: 'ok', conditions: 'no', repo: null, token: null, why: {reason: 'client settings unreadable'}};
    const s = await shim.session(r.socket, secret, no);
    assert.ok(s.welcome != null && s.settled != null && s.settled.op === 'settled', JSON.stringify(s.refused || s.settled));
    const set = async (value) => request(s.c, 'tools/call', {name: 'countinghouse_settings', arguments: {action: 'set', name: 'requestTimeout', value}});
    const value = async () => (await request(s.c, 'tools/call', {name: 'countinghouse_settings', arguments: {action: 'get'}}))
      .result.structuredContent.settings.find((x) => x.name === 'requestTimeout').value;
    assert.deepStrictEqual((await set('10s')).result.structuredContent, {name: 'requestTimeout', old: 30000, new: 10000, applies: 'this session'});
    // the latch is there: a loosening is refused with its text
    const above = await set('45s');
    assert.strictEqual(above.result._meta['countinghouse/code'], 'SETTING_CLIENT_NOT_CONFIRMED', JSON.stringify(above));
    assert.match(above.result.content[0].text, /client settings unreadable/);
    assert.strictEqual(await value(), 10000);
    const undone = await set('30s');
    assert.deepStrictEqual(undone.result.structuredContent, {name: 'requestTimeout', old: 10000, new: 30000, applies: 'this session'}, JSON.stringify(undone));
    assert.strictEqual(await value(), 30000);
    assert.strictEqual(await s.c.json('C', 300), null, 'its client was asked nothing');
    assert.ok(!fs.existsSync(settingsFile), 'settings.json never written');
    const lines = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.filter((l) => l.change === 'this session: its own lowering undone').map((l) => [l.setting, l.old, l.new]), [['requestTimeout', 10000, 30000]]);
    s.c.end();
  });

  trees.hooks();
});

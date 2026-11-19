// bin/countinghouse-validate.js is the same oracle as lib/module-validator.js,
// reachable from a shell. It exists for humans, for CI, and for agents that
// can run a command but have no MCP server up.
const assert = require('assert');
const path   = require('path');
const exec   = require('child_process').exec;

const ROOT     = path.join(__dirname, '..', '..');
const BIN      = path.join(ROOT, 'bin', 'countinghouse-validate.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function run(args, done) {
  exec(`node ${BIN} ${args}`, {cwd: ROOT}, (err, stdout, stderr) => {
    done({code: err == null ? 0 : err.code, stdout: stdout, stderr: stderr});
  });
}

// this file's temporary trees, under test/.tmp and removed
// (test/helpers/test-tmp.js forFile); nothing left in os.tmpdir()
const tmpDirs = require('../helpers/test-tmp').forFile(['ch-validate-cli-']);

describe('countinghouse-validate CLI', function() {
  tmpDirs.hooks();
  this.timeout(20000);

  it('exits 0 and says so for a clean module', (done) => {
    run(path.join(FIXTURES, 'handler-map-convention'), (r) => {
      assert.strictEqual(r.code, 0);
      assert.ok(/ok/i.test(r.stdout), `expected an ok line, got: ${r.stdout}`);
      done();
    });
  });

  it('exits 1 and prints every problem for a broken module', (done) => {
    run(path.join(FIXTURES, 'handler-map-unknown-service'), (r) => {
      assert.strictEqual(r.code, 1);
      assert.ok(/greetingService/.test(r.stdout + r.stderr));
      done();
    });
  });

  // M3 (#413 section 6.1): each remote in its expanded form, and what it
  // means, whichever form the author wrote; asserted byte for byte.
  const withRemote = (remote) => {
    const fs = require('fs');
    const dir = path.join(tmpDirs.mkdtemp('ch-validate-cli-'), 'm');
    fs.cpSync(path.join(FIXTURES, 'handler-map-convention'), dir, {recursive: true});
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.countinghouse = Object.assign({}, pkg.countinghouse, {remotes: [remote]});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return {dir: dir, name: pkg.name};
  };

  it('prints a remote declared in the short form expanded, and where its credential goes', (done) => {
    const m = withRemote({name: 'github', url: 'https://api.githubcopilot.com/mcp/', credential: 'GITHUB_TOKEN'});
    run(m.dir, (r) => {
      assert.strictEqual(r.code, 0, r.stdout + r.stderr);
      assert.strictEqual(r.stdout,
        `ok: ${m.name} -- no problems found\n` +
        'remote github: {"name":"github","transport":"streamable-http","url":"https://api.githubcopilot.com/mcp/","credential":{"env":"GITHUB_TOKEN","header":"Authorization","scheme":"Bearer"}}\n' +
        '  sends the credential GITHUB_TOKEN to https://api.githubcopilot.com as "Authorization: Bearer <value>"\n');
      done();
    });
  });

  it('a bare-token header, and a remote with no credential, say so', (done) => {
    const m = withRemote({name: 'keyed', url: 'https://api.example.com/mcp', credential: {env: 'API_KEY', header: 'X-Api-Key', scheme: ''}});
    run(m.dir, (r) => {
      assert.ok(r.stdout.includes('\n  sends the credential API_KEY to https://api.example.com as "X-Api-Key: <value>"\n'), r.stdout);
      const open = withRemote({name: 'open', url: 'https://api.example.com/mcp'});
      run(open.dir, (o) => {
        assert.ok(o.stdout.endsWith('remote open: {"name":"open","transport":"streamable-http","url":"https://api.example.com/mcp"}\n' +
          '  sends no credential to https://api.example.com\n'), o.stdout);
        done();
      });
    });
  });

  it('--json carries the remotes, expanded, with what each means', (done) => {
    const m = withRemote({name: 'github', url: 'https://api.githubcopilot.com/mcp/', credential: 'GITHUB_TOKEN'});
    run(`--json ${m.dir}`, (r) => {
      const out = JSON.parse(r.stdout);
      assert.deepStrictEqual(out.remotes, [{declared: {name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
        credential: {env: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}},
      meaning: 'sends the credential GITHUB_TOKEN to https://api.githubcopilot.com as "Authorization: Bearer <value>"'}]);
      done();
    });
  });

  it('a wrong declaration\'s fix line shows the short form, filled in with what the author wrote', (done) => {
    const m = withRemote({name: 'gh', transport: 'streamable-http', url: 'https://example.com/mcp', credential: {env: 'GH_TOKEN', extra: 1}});
    run(m.dir, (r) => {
      assert.strictEqual(r.code, 1);
      assert.ok(r.stdout.includes('      fix: the shortest form is {"name":"gh","url":"https://example.com/mcp","credential":"GH_TOKEN"}; ' +
        'see "Declaring a remote MCP server" in docs/module-development.md\n'), r.stdout);
      done();
    });
  });

  // #422 high review, 3: a URL the checks refuse is not offered back
  it('a refused URL (http, a loopback or private host) is not in the fix line: a placeholder is', (done) => {
    const urls = ['http://example.com/mcp', 'https://127.0.0.1/mcp', 'https://10.0.0.1/mcp'];
    let left = urls.length;
    for (const url of urls) {
      run(withRemote({name: 'gh', url: url, credential: 'GH_TOKEN'}).dir, (r) => {
        assert.ok(r.stdout.includes('fix: the shortest form is {"name":"gh","url":"<https URL of your server>","credential":"GH_TOKEN"}'), `${url}: ${r.stdout}`);
        if (--left === 0) done();
      });
    }
  });

  // the medium review of the high-review fixes: a query can carry a secret
  it('a URL that passes keeps its path, and its query is replaced by a placeholder', (done) => {
    const token = ['t', 'o', 'k', '7', '7'].join('');
    run(withRemote({name: 'gh', url: `https://example.com/mcp/v1?access_token=${token}`, credential: {env: 'GH_TOKEN', extra: 1}}).dir, (r) => {
      assert.ok(!r.stdout.includes(token), r.stdout);
      assert.ok(r.stdout.includes('"url":"https://example.com/mcp/v1?<query>"'), r.stdout);
      done();
    });
  });

  it('a credential field the grammar refuses is a placeholder in the full form, never dropped', (done) => {
    run(withRemote({name: 'gh', url: 'https://example.com/mcp', credential: {env: 'GH_TOKEN', header: 'Bad Header', scheme: 'B a d', fallbackEnv: '1X'}}).dir, (r) => {
      assert.ok(r.stdout.includes('"credential":{"env":"GH_TOKEN","fallbackEnv":"<VARIABLE>","header":"<header>","scheme":"<scheme>"}'), r.stdout);
      done();
    });
  });

  // #422 high review, 5: the short form only where it means the same
  it('with headers, or a credential header or scheme of its own, the fix line shows the full form, header values left out', (done) => {
    const m = withRemote({name: 'gh', url: 'https://example.com/mcp', headers: {'X-Toolsets': 'secret-ish'}, credential: {env: 'GH_TOKEN', header: 'X-Api-Key', scheme: '', extra: 1}});
    run(m.dir, (r) => {
      assert.ok(r.stdout.includes('fix: the full form is {"name":"gh","transport":"streamable-http","url":"https://example.com/mcp","headers":{"X-Toolsets":"<value>"},' +
        '"credential":{"env":"GH_TOKEN","header":"X-Api-Key","scheme":""}}'), r.stdout);
      assert.ok(!r.stdout.includes('secret-ish'), r.stdout);
      done();
    });
  });

  // the review of M3: a URL's user info is never printed back
  it('the fix line never prints a URL\'s user info or fragment', (done) => {
    // built at run time: no credential pair in the source
    const secret = ['pa', 'ss', 'word', '42'].join('');
    const u = new URL('https://api.example.com/mcp#frag');
    u.username = 'bot';
    u.password = secret;
    const m = withRemote({name: 'gh', url: u.href, credential: 'GH_TOKEN'});
    run(m.dir, (r) => {
      assert.strictEqual(r.code, 1);
      assert.ok(!r.stdout.includes(secret) && !r.stdout.includes('#frag'), r.stdout);
      // a URL with user info fails the URL checks: the placeholder (#422's high review, 3)
      assert.ok(r.stdout.includes('the shortest form is {"name":"gh","url":"<https URL of your server>","credential":"GH_TOKEN"}'), r.stdout);
      done();
    });
  });

  it('a fallbackEnv is said to be read under a version 1 file only', (done) => {
    const m = withRemote({name: 'gh', url: 'https://api.example.com/mcp', credential: {env: 'A_TOKEN', fallbackEnv: 'B_TOKEN'}});
    run(m.dir, (r) => {
      assert.ok(r.stdout.includes('  sends the credential A_TOKEN to https://api.example.com as "Authorization: Bearer <value>" ' +
        '(its fallbackEnv B_TOKEN is read only under a version 1 --remoteCredentials file)\n'), r.stdout);
      done();
    });
  });

  it('exits 2 when the path does not exist', (done) => {
    run(path.join(FIXTURES, 'no-such-module-anywhere'), (r) => {
      assert.strictEqual(r.code, 2);
      done();
    });
  });

  it('exits 2 with usage when given no argument', (done) => {
    run('', (r) => {
      assert.strictEqual(r.code, 2);
      assert.ok(/usage/i.test(r.stdout + r.stderr));
      done();
    });
  });
});

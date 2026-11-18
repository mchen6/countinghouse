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

describe('countinghouse-validate CLI', function() {
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
    const os = require('os');
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-validate-cli-')), 'm');
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
    const m = withRemote({name: 'gh', transport: 'streamable-http', url: 'http://example.com/mcp', credential: {env: 'GH_TOKEN', extra: 1}});
    run(m.dir, (r) => {
      assert.strictEqual(r.code, 1);
      assert.ok(r.stdout.includes('      fix: the shortest form is {"name":"gh","url":"http://example.com/mcp","credential":"GH_TOKEN"}; ' +
        'see "Declaring a remote MCP server" in docs/module-development.md\n'), r.stdout);
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

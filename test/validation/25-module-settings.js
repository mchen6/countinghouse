'use strict';
// Module settings, the declaration and its values (the module-level
// configuration design, section 4.1, 4.2, 4.7; lib/module-settings.js).
// Server-free.
// - the declaration's vocabulary: every field's bounds, refused by position
//   and field; names that are Object.prototype members; the whole at most
//   16 KiB; an npm-grammar package name; the validator's warnings
//   (a secret-looking name or title, a part's `required`);
// - each format's accept and refuse cases and its 1024-character
//   worst-case timing bound;
// - a value: refused with a hidden character (a title is not: it is cleaned
//   at egress); a `hostname` or `url` outside the module's granted net;
// - effective values: defaults, then stored, then the ceiling's fixed ones;
//   a stored value the declaration no longer accepts is not applied (and
//   said), an empty string is unset, a default outside the grants is unset
//   with a warning, a fixed value the declaration rejects refuses the load;
//   frozen, null-prototype; at most 32 KiB.
const assert = require('assert');
const ms = require('../../lib/module-settings');

const pkgWith = (settings, extra = {}) => Object.assign({name: '@acme/weather-tool', version: '1.0.0', countinghouse: Object.assign({settings}, extra)});
const problemsOf = (settings, extra) => ms.parseDeclaration(pkgWith(settings, extra)).problems;
const refusedAt = (settings, at) => {
  const p = problemsOf(settings);
  assert.ok(p.some((x) => x.at === at), `want a problem at ${at}: ${JSON.stringify(p)}`);
};
const accepted = (settings) => {
  const p = problemsOf(settings);
  assert.deepStrictEqual(p, [], JSON.stringify(p));
};

const EXAMPLE = {
  units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric', title: 'Units', description: 'Units used in forecasts.'},
  defaultRepo: {type: 'string', format: 'repo', title: 'Default repository', description: 'owner/name used when a call names no repository.'},
  maxResults: {type: 'integer', min: 1, max: 100, default: 20, title: 'Results per call'},
  shareStats: {type: 'boolean', default: false, confirm: true, title: 'Send anonymous usage statistics'},
  ratio: {type: 'number', min: 0, max: 1, default: 0.5},
  region: {type: 'string', required: true},
};

describe('validation 25: module settings, the declaration and its values', () => {
  describe('the declaration', () => {
    it('the design\'s example is accepted, and each setting comes back as declared', () => {
      const d = ms.parseDeclaration(pkgWith(EXAMPLE));
      assert.deepStrictEqual(d.problems, []);
      assert.deepStrictEqual(Object.keys(d.settings).sort(), Object.keys(EXAMPLE).sort());
      assert.strictEqual(d.settings.defaultRepo.maxLength, 256, 'a string\'s maxLength defaults to 256');
      assert.ok(Object.isFrozen(d.settings) && Object.isFrozen(d.settings.units));
      assert.strictEqual(Object.getPrototypeOf(d.settings), null);
    });

    it('no settings, or an empty object: nothing declared, no problem', () => {
      for (const pkg of [{name: 'x', countinghouse: {}}, {name: 'x'}, pkgWith({})]) {
        const d = ms.parseDeclaration(pkg);
        assert.deepStrictEqual(d.problems, []);
        assert.strictEqual(d.settings, null);
      }
    });

    it('settings that are not an object is refused', () => {
      for (const s of [[], 'x', 3, true]) {
        assert.ok(problemsOf(s).some((p) => p.at === 'countinghouse.settings'), JSON.stringify(s));
      }
    });

    it('names: [a-z][a-zA-Z0-9_]{0,63}, no dots, not an Object.prototype member; at most 32', () => {
      accepted({a: {type: 'boolean'}, a_B9: {type: 'boolean'}, ['a'.repeat(64)]: {type: 'boolean'}});
      for (const bad of ['A', '9a', 'a.b', 'a-b', '', 'a'.repeat(65), 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
        const settings = JSON.parse(`{${JSON.stringify(bad)}: {"type": "boolean"}}`);   // __proto__ as an own key
        refusedAt(settings, `countinghouse.settings[${JSON.stringify(bad)}]`);
      }
      const many = {};
      for (let i = 0; i < 33; i++) many[`s${i}`] = {type: 'boolean'};
      assert.ok(problemsOf(many).some((p) => p.at === 'countinghouse.settings' && /32/.test(p.message)));
    });

    it('type is one of string, integer, number, boolean, enum', () => {
      refusedAt({a: {type: 'object'}}, 'countinghouse.settings.a.type');
      refusedAt({a: {}}, 'countinghouse.settings.a.type');
    });

    it('values: enum only, 1 to 64 distinct strings of 1 to 64 characters of [A-Za-z0-9 _.:/@+-]', () => {
      accepted({a: {type: 'enum', values: ['x', 'A b_.:/@+-9']}});
      refusedAt({a: {type: 'enum'}}, 'countinghouse.settings.a.values');
      refusedAt({a: {type: 'enum', values: []}}, 'countinghouse.settings.a.values');
      refusedAt({a: {type: 'enum', values: new Array(65).fill(0).map((_, i) => `v${i}`)}}, 'countinghouse.settings.a.values');
      refusedAt({a: {type: 'enum', values: ['']}}, 'countinghouse.settings.a.values');
      refusedAt({a: {type: 'enum', values: ['x'.repeat(65)]}}, 'countinghouse.settings.a.values');
      refusedAt({a: {type: 'enum', values: ['a;b']}}, 'countinghouse.settings.a.values');
      refusedAt({a: {type: 'enum', values: ['x', 'x']}}, 'countinghouse.settings.a.values');
      refusedAt({a: {type: 'enum', values: [1]}}, 'countinghouse.settings.a.values');
      refusedAt({a: {type: 'string', values: ['x']}}, 'countinghouse.settings.a.values');
    });

    it('min and max: integer and number only, finite, min <= max (integers for an integer)', () => {
      accepted({a: {type: 'integer', min: -5, max: 5}, b: {type: 'number', min: 0.5}});
      refusedAt({a: {type: 'string', min: 1}}, 'countinghouse.settings.a.min');
      refusedAt({a: {type: 'integer', max: Infinity}}, 'countinghouse.settings.a.max');
      refusedAt({a: {type: 'integer', min: '1'}}, 'countinghouse.settings.a.min');
      refusedAt({a: {type: 'integer', min: 1.5}}, 'countinghouse.settings.a.min');
      refusedAt({a: {type: 'number', min: 2, max: 1}}, 'countinghouse.settings.a.max');
    });

    it('maxLength: string only, an integer 1 to 1024', () => {
      accepted({a: {type: 'string', maxLength: 1}, b: {type: 'string', maxLength: 1024}});
      for (const bad of [0, 1025, 1.5, '10']) refusedAt({a: {type: 'string', maxLength: bad}}, 'countinghouse.settings.a.maxLength');
      refusedAt({a: {type: 'integer', maxLength: 5}}, 'countinghouse.settings.a.maxLength');
    });

    it('format: string only, one of slug, repo, email, hostname, url (no pattern, no path)', () => {
      for (const f of ['slug', 'repo', 'email', 'hostname', 'url']) accepted({a: {type: 'string', format: f}});
      for (const f of ['path', 'pattern', 'uri', 'URL', '']) refusedAt({a: {type: 'string', format: f}}, 'countinghouse.settings.a.format');
      refusedAt({a: {type: 'enum', values: ['x'], format: 'slug'}}, 'countinghouse.settings.a.format');
      refusedAt({a: {type: 'string', pattern: '^x$'}}, 'countinghouse.settings.a.pattern');
    });

    it('default: must itself be valid', () => {
      accepted({a: {type: 'integer', min: 1, max: 3, default: 2}, b: {type: 'string', format: 'slug', default: 'ok-1'}});
      refusedAt({a: {type: 'integer', min: 1, max: 3, default: 4}}, 'countinghouse.settings.a.default');
      refusedAt({a: {type: 'enum', values: ['x'], default: 'y'}}, 'countinghouse.settings.a.default');
      refusedAt({a: {type: 'boolean', default: 'true'}}, 'countinghouse.settings.a.default');
      refusedAt({a: {type: 'string', format: 'repo', default: 'not a repo'}}, 'countinghouse.settings.a.default');
      refusedAt({a: {type: 'string', default: 'x​y'}}, 'countinghouse.settings.a.default');
    });

    it('required and confirm: booleans; title at most 64, description at most 512, strings', () => {
      refusedAt({a: {type: 'boolean', required: 'yes'}}, 'countinghouse.settings.a.required');
      refusedAt({a: {type: 'boolean', confirm: 1}}, 'countinghouse.settings.a.confirm');
      refusedAt({a: {type: 'boolean', title: 'x'.repeat(65)}}, 'countinghouse.settings.a.title');
      refusedAt({a: {type: 'boolean', description: 'x'.repeat(513)}}, 'countinghouse.settings.a.description');
      refusedAt({a: {type: 'boolean', title: 3}}, 'countinghouse.settings.a.title');
    });

    it('a hidden character in a title or a description is accepted (cleaned at egress, as every declared text)', () => {
      accepted({a: {type: 'boolean', title: 'Uni​ts', description: 'x‮y'}});
    });

    it('an unknown field is refused, naming it', () => {
      refusedAt({a: {type: 'boolean', secret: true}}, 'countinghouse.settings.a.secret');
    });

    it('the whole declaration is at most 16 KiB', () => {
      const big = {};
      for (let i = 0; i < 32; i++) big[`s${i}`] = {type: 'string', description: 'd'.repeat(512), title: 't'.repeat(64)};
      assert.ok(problemsOf(big).some((p) => p.at === 'countinghouse.settings' && /16 KiB/.test(p.message)));
    });

    it('a module that declares settings has an npm-grammar package name', () => {
      for (const name of ['weather-tool', '@acme/weather-tool', 'a.b_c~d']) {
        assert.deepStrictEqual(ms.parseDeclaration({name, countinghouse: {settings: {a: {type: 'boolean'}}}}).problems, [], name);
      }
      for (const name of ['Weather', '@acme', '.x', '_x', 'a b', '@a/b/c', '', 'x'.repeat(215), undefined]) {
        const p = ms.parseDeclaration({name, countinghouse: {settings: {a: {type: 'boolean'}}}}).problems;
        assert.ok(p.some((x) => x.at === 'name'), `${name}: ${JSON.stringify(p)}`);
      }
    });

    it('each problem says what was wrong and how to fix it', () => {
      const [p] = problemsOf({a: {type: 'integer', min: 1.5}});
      assert.ok(typeof p.message === 'string' && p.message.length > 0 && typeof p.fix === 'string' && p.fix.length > 0, JSON.stringify(p));
    });
  });

  describe('the validator\'s warnings and each setting\'s confirmation rule', () => {
    it('a name or title that looks like a secret is warned about', () => {
      for (const s of [{apiKey: {type: 'string'}}, {githubToken: {type: 'string'}}, {a: {type: 'string', title: 'Your password'}},
        {a: {type: 'string', title: 'Client SECRET'}}, {credential: {type: 'string'}}]) {
        const d = ms.parseDeclaration(pkgWith(s));
        assert.deepStrictEqual(d.problems, []);
        assert.ok(d.warnings.some((w) => /secret/i.test(w) && /credential/.test(w)), JSON.stringify(d.warnings));
      }
      assert.deepStrictEqual(ms.parseDeclaration(pkgWith({units: {type: 'boolean', title: 'Units'}})).warnings, []);
    });

    it('a part that declares a required setting is warned about', () => {
      const d = ms.parseDeclaration(pkgWith({region: {type: 'string', required: true}}, {role: 'part'}));
      assert.ok(d.warnings.some((w) => /part/.test(w) && /required/.test(w)), JSON.stringify(d.warnings));
      assert.deepStrictEqual(ms.parseDeclaration(pkgWith({region: {type: 'string', required: true}}, {role: 'scenario'})).warnings, []);
    });

    it('the confirmation rule: on request for enum, integer, number, boolean; confirmation for every string and every confirm: true', () => {
      const d = ms.parseDeclaration(pkgWith(EXAMPLE)).settings;
      assert.strictEqual(ms.confirmRule(d.units), 'on request');
      assert.strictEqual(ms.confirmRule(d.maxResults), 'on request');
      assert.strictEqual(ms.confirmRule(d.ratio), 'on request');
      assert.strictEqual(ms.confirmRule(d.shareStats), 'confirm');
      assert.strictEqual(ms.confirmRule(d.defaultRepo), 'confirm');
      assert.strictEqual(ms.confirmRule(d.region), 'confirm');
    });
  });

  describe('the formats', () => {
    const accept = (f, v, canonical = v) => assert.strictEqual(ms.FORMATS[f](v), canonical, `${f} accepts ${JSON.stringify(v)}`);
    const refuse = (f, v) => assert.strictEqual(ms.FORMATS[f](v), null, `${f} refuses ${JSON.stringify(v)}`);

    it('slug: [a-z0-9][a-z0-9-]{0,63}', () => {
      for (const v of ['a', '0', 'a-b-9', 'a'.repeat(64)]) accept('slug', v);
      for (const v of ['', '-a', 'A', 'a_b', 'a'.repeat(65), 'a.b']) refuse('slug', v);
    });

    it('repo: owner/name in GitHub\'s grammar', () => {
      for (const v of ['acme/api', 'a/b', 'a-b/c.d_e-f', `${'o'.repeat(39)}/${'r'.repeat(100)}`]) accept('repo', v);
      for (const v of ['acme', 'acme/', '/api', '-acme/api', 'acme-/api', 'ac--me/api', `${'o'.repeat(40)}/r`, `o/${'r'.repeat(101)}`,
        'acme/.', 'acme/..', 'acme/a b', 'a/b/c', 'acme/api?x']) refuse('repo', v);
    });

    it('email: local@domain, the domain a hostname', () => {
      for (const v of ['a@b.co', 'first.last+tag@example.org', 'x_y@sub.example.com']) accept('email', v);
      for (const v of ['a', '@b.co', 'a@', 'a@b', 'a b@c.co', 'a@-b.co', 'a@b..co', `${'a'.repeat(65)}@b.co`, 'a@@b.co']) refuse('email', v);
    });

    it('hostname: labels of [a-z0-9-], 1 to 63, no leading or trailing hyphen; at most 253; lowercased', () => {
      for (const v of ['example.org', 'a-b.example.org', 'localhost']) accept('hostname', v);
      accept('hostname', 'API.Example.org', 'api.example.org');
      for (const v of ['', '-a.org', 'a-.org', 'a..org', '.a.org', 'a.org.', 'a_b.org', `${'a'.repeat(64)}.org`, `${'a.'.repeat(127)}org`, 'a b.org', 'exámple.org']) refuse('hostname', v);
    });

    it('url: https only, no user info, in canonical form', () => {
      accept('url', 'https://example.org/a?b=c', 'https://example.org/a?b=c');
      accept('url', 'https://EXAMPLE.org', 'https://example.org/');
      for (const v of ['http://example.org/', 'ftp://example.org/', 'https://u:p@example.org/', 'https://u@example.org/', 'example.org', 'https://', 'javascript:alert(1)']) refuse('url', v);
    });

    it('each checker takes at most a few milliseconds on a 1024-character worst case', () => {
      const worst = {
        slug: ['a'.repeat(1024), `${'a-'.repeat(511)}!`],
        repo: [`${'a-'.repeat(512)}`, `${'a'.repeat(512)}/${'b'.repeat(511)}`, '/'.repeat(1024)],
        email: [`${'a'.repeat(1000)}@${'b.'.repeat(11)}c`, `${'a@'.repeat(512)}`, `a@${'b-'.repeat(511)}`],
        hostname: [`${'a-'.repeat(511)}!`, `${'a.'.repeat(512)}`, '-'.repeat(1024)],
        url: [`https://example.org/${'a'.repeat(1004)}`, `https://${'a.'.repeat(504)}org/`, `https://${'%'.repeat(1016)}`],
      };
      for (const f of Object.keys(worst)) {
        for (const v of worst[f]) {
          const t0 = process.hrtime.bigint();
          for (let i = 0; i < 20; i++) ms.FORMATS[f](v);
          const each = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
          assert.ok(each < 5, `${f} took ${each.toFixed(2)} ms on ${JSON.stringify(v.slice(0, 40))}...`);
        }
      }
    });
  });

  describe('a value', () => {
    const d = ms.parseDeclaration(pkgWith({
      units: {type: 'enum', values: ['metric', 'imperial']},
      n: {type: 'integer', min: 1, max: 100},
      r: {type: 'number', min: 0, max: 1},
      b: {type: 'boolean'},
      s: {type: 'string', maxLength: 4},
      host: {type: 'string', format: 'hostname'},
      link: {type: 'string', format: 'url'},
    })).settings;
    const net = [{host: 'api.example.org', ports: null}, {host: '*.acme.dev', ports: [443]}];

    it('each type takes only its own values', () => {
      assert.deepStrictEqual(ms.checkValue(d.units, 'imperial', {net}), {ok: true, value: 'imperial'});
      assert.strictEqual(ms.checkValue(d.units, 'kelvin', {net}).ok, false);
      assert.strictEqual(ms.checkValue(d.n, 5, {net}).ok, true);
      for (const v of [0, 101, 2.5, '5', NaN]) assert.strictEqual(ms.checkValue(d.n, v, {net}).ok, false, String(v));
      assert.strictEqual(ms.checkValue(d.r, 0.25, {net}).ok, true);
      for (const v of [-0.1, 1.1, Infinity, '0.5']) assert.strictEqual(ms.checkValue(d.r, v, {net}).ok, false, String(v));
      assert.strictEqual(ms.checkValue(d.b, false, {net}).ok, true);
      assert.strictEqual(ms.checkValue(d.b, 'false', {net}).ok, false);
      assert.strictEqual(ms.checkValue(d.s, 'abcd', {net}).ok, true);
      assert.strictEqual(ms.checkValue(d.s, 'abcde', {net}).ok, false);
      assert.strictEqual(ms.checkValue(d.s, '\u{1F600}\u{1F600}\u{1F600}\u{1F600}', {net}).ok, true, 'maxLength counts code points');
    });

    it('a refusal says what is allowed, and never carries the value', () => {
      const r = ms.checkValue(d.units, 'kelvin-secret', {net});
      assert.match(r.reason, /metric or imperial/);
      assert.ok(!r.reason.includes('kelvin-secret'), r.reason);
    });

    it('a value with a hidden character is refused, never cleaned', () => {
      const r = ms.checkValue(d.s, 'a​b', {net});
      assert.strictEqual(r.ok, false);
      assert.match(r.reason, /hidden/);
    });

    it('a hostname or url inside the granted net is taken; outside, SETTING_OUT_OF_BOUNDS', () => {
      assert.deepStrictEqual(ms.checkValue(d.host, 'API.example.org', {net}), {ok: true, value: 'api.example.org'});
      assert.strictEqual(ms.checkValue(d.host, 'x.acme.dev', {net}).ok, true);
      assert.strictEqual(ms.checkValue(d.link, 'https://api.example.org/v1', {net}).ok, true);
      assert.strictEqual(ms.checkValue(d.link, 'https://x.acme.dev/', {net}).ok, true, 'https is port 443');
      for (const [s, v] of [[d.host, 'evil.example'], [d.link, 'https://evil.example/'], [d.link, 'https://x.acme.dev:8443/'], [d.host, 'a.b.acme.dev']]) {
        const r = ms.checkValue(s, v, {net});
        assert.strictEqual(r.ok, false, v);
        assert.strictEqual(r.code, 'SETTING_OUT_OF_BOUNDS', v);
        assert.match(r.reason, /operator/);
      }
      assert.strictEqual(ms.checkValue(d.host, 'api.example.org', {net: []}).code, 'SETTING_OUT_OF_BOUNDS', 'no grant, nothing inside it');
    });
  });

  describe('effective values', () => {
    const decl = ms.parseDeclaration(pkgWith({
      units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'},
      n: {type: 'integer', min: 1, max: 10, default: 5},
      repo: {type: 'string', format: 'repo'},
      host: {type: 'string', format: 'hostname', default: 'api.example.org'},
    })).settings;
    const net = [{host: 'api.example.org', ports: null}];

    it('the defaults, then the stored values; an unset setting is absent; frozen, null-prototype', () => {
      const e = ms.effective(decl, {units: 'imperial'}, {net});
      assert.strictEqual(e.refused, null);
      assert.deepStrictEqual(Object.assign({}, e.values), {units: 'imperial', n: 5, host: 'api.example.org'});
      assert.ok(Object.isFrozen(e.values));
      assert.strictEqual(Object.getPrototypeOf(e.values), null);
      assert.strictEqual('repo' in e.values, false);
    });

    it('an empty stored string is unset; an explicit value equal to the default is kept as the value', () => {
      const e = ms.effective(decl, {repo: '', units: 'metric'}, {net});
      assert.strictEqual('repo' in e.values, false);
      assert.strictEqual(e.values.units, 'metric');
      assert.deepStrictEqual(e.notApplied, []);
    });

    it('a stored value the declaration no longer accepts is not applied: the default, or unset, and it is said (not its value)', () => {
      const e = ms.effective(decl, {units: 'kelvin', n: 11, repo: 'no', gone: 'x'}, {net});
      assert.strictEqual(e.values.units, 'metric');
      assert.strictEqual(e.values.n, 5);
      assert.strictEqual('repo' in e.values, false);
      assert.deepStrictEqual(e.notApplied.map((x) => x.setting).sort(), ['gone', 'n', 'repo', 'units']);
      for (const x of e.notApplied) assert.ok(!JSON.stringify(x).includes('kelvin'), JSON.stringify(x));
    });

    it('a default outside a narrowed grant is unset, with a warning; the load goes on', () => {
      const e = ms.effective(decl, {}, {net: []});
      assert.strictEqual(e.refused, null);
      assert.strictEqual('host' in e.values, false);
      assert.ok(e.warnings.some((w) => /host/.test(w) && /grant/.test(w)), JSON.stringify(e.warnings));
    });

    it('the ceiling\'s fixed values win; one the declaration rejects refuses the load', () => {
      const e = ms.effective(decl, {units: 'metric'}, {net, fixed: {units: 'imperial'}});
      assert.strictEqual(e.values.units, 'imperial');
      const bad = ms.effective(decl, {}, {net, fixed: {units: 'kelvin'}});
      assert.ok(bad.refused != null && /ceiling/.test(bad.refused), JSON.stringify(bad));
    });

    it('the effective values are at most 32 KiB, or the load is refused', () => {
      const wide = {};
      for (let i = 0; i < 32; i++) wide[`s${i}`] = {type: 'string', maxLength: 1024};
      const d = ms.parseDeclaration(pkgWith(wide)).settings;
      const stored = {};
      for (let i = 0; i < 32; i++) stored[`s${i}`] = '\u{1F600}'.repeat(1024);
      const e = ms.effective(d, stored, {net});
      assert.ok(e.refused != null && /32 KiB/.test(e.refused), JSON.stringify(e.refused));
    });

    it('an empty string default is unset, and a required setting with it is unset', () => {
      const d = ms.parseDeclaration(pkgWith({a: {type: 'string', required: true, default: ''}})).settings;
      const e = ms.effective(d, {}, {net});
      assert.strictEqual('a' in e.values, false);
      assert.deepStrictEqual(ms.unsetRequired(d, e.values), ['a']);
    });

    it('the required settings left unset', () => {
      const d = ms.parseDeclaration(pkgWith({a: {type: 'string', required: true}, b: {type: 'string', required: true, default: 'x'}, c: {type: 'string'}})).settings;
      assert.deepStrictEqual(ms.unsetRequired(d, ms.effective(d, {}, {net}).values), ['a']);
      assert.deepStrictEqual(ms.unsetRequired(d, ms.effective(d, {a: 'y'}, {net}).values), []);
    });
  });
});

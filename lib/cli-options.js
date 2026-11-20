'use strict';

// The text a flag was given on the command line (--name value, or
// --name=value), for a value minimist turned into a number; the number's own
// text when it is not there (options set by a caller, not parsed).
function rawFlagText(name, parsed) {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return String(parsed);
}
// do not require CHUtil here to avoid circular dep
// var CHUtil = require('./countinghouse-util');
const isMainThread = require('worker_threads').isMainThread;
const threadInfo   = require('./thread-info');
const path         = require('path');
const net          = require('net');

// $HOME (%USERPROFILE%)/.countinghouse/module_data, in the host's separators.
// An unset or empty variable falls back to the OS's home directory; with
// none at all, the start refuses, saying so (never a relative path).
function defaultModuleDataPath() {
  const home = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] || require('os').homedir();
  if (typeof(home) !== 'string' || home === '' || !path.isAbsolute(home)) {
    throw new Error('no home directory to put module data in: set HOME (USERPROFILE on Windows), or pass --moduleDataPath');
  }
  return path.join(home, '.countinghouse', 'module_data');
}
// An IP address as its eight 16-bit groups -- an IPv4 address as its
// IPv4-mapped IPv6 form (::ffff:a.b.c.d), case, a zone and an embedded IPv4
// tail read -- or null. (lib/unauth-limit.js keys a client by it too.)
function ipGroups(text) {
  let a = String(text).trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  if (net.isIPv4(a)) a = `::ffff:${a}`;
  if (!net.isIPv6(a)) return null;
  let tail4 = null;
  const lastColon = a.lastIndexOf(':');
  if (net.isIPv4(a.slice(lastColon + 1))) {
    const p = a.slice(lastColon + 1).split('.').map(Number);
    tail4 = [p[0] * 256 + p[1], p[2] * 256 + p[3]];
    a = `${a.slice(0, lastColon + 1)}0:0`;
  }
  const part = (x) => (x === '' ? [] : x.split(':'));
  const dbl = a.indexOf('::');
  let groups = part(a);
  if (dbl !== -1) {
    const head = part(a.slice(0, dbl));
    const tail = part(a.slice(dbl + 2));
    groups = head.concat(Array(8 - head.length - tail.length).fill('0'), tail);
  }
  const g = groups.map((x) => parseInt(x, 16));
  if (tail4 != null) { g[6] = tail4[0]; g[7] = tail4[1]; }
  return (g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff)) ? g : null;
}
// --trustProxy's list entry, as Express's 'trust proxy' takes it: an IP
// address, one with a /prefix (each as a range of the IPv6 space, an IPv4
// one IPv4-mapped), or one of Express's names for a private range -> the
// range {start, end} as BigInts, 'named', or null.
const TRUST_NAMES = ['loopback', 'linklocal', 'uniquelocal'];
function trustedProxyRange(x) {
  if (TRUST_NAMES.includes(x)) return 'named';
  const [ip, prefix, more] = x.split('/');
  const g = ipGroups(ip);
  if (g == null || more !== undefined || ip.includes('%')) return null;
  const v4 = net.isIPv4(ip);
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return null;
  const bits = prefix === undefined ? (v4 ? 32 : 128) : Number(prefix);
  if (bits > (v4 ? 32 : 128)) return null;
  const width = BigInt(128 - (v4 ? bits + 96 : bits));
  const value = g.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n);
  const start = (value >> width) << width;
  return {start, end: start + (1n << width) - 1n};
}
// The addresses a set of ranges covers, the IPv4 (IPv4-mapped) ones and the
// rest apart, each range counted once however the entries overlap.
const MAPPED = {start: 0xffffn << 32n, end: (0xffffn << 32n) + 0xffffffffn};
function coverage(ranges) {
  const size = (rs) => {
    const sorted = rs.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    let total = 0n;
    let cur = null;
    for (const r of sorted) {
      if (cur != null && r.start <= cur.end + 1n) { if (r.end > cur.end) cur.end = r.end; continue; }
      if (cur != null) total += cur.end - cur.start + 1n;
      cur = {start: r.start, end: r.end};
    }
    return cur != null ? total + cur.end - cur.start + 1n : total;
  };
  const inside = [];
  const outside = [];
  for (const r of ranges) {
    if (r.start <= MAPPED.end && r.end >= MAPPED.start) inside.push({start: r.start > MAPPED.start ? r.start : MAPPED.start, end: r.end < MAPPED.end ? r.end : MAPPED.end});
    if (r.start < MAPPED.start) outside.push({start: r.start, end: r.end < MAPPED.start - 1n ? r.end : MAPPED.start - 1n});
    if (r.end > MAPPED.end) outside.push({start: r.start > MAPPED.end + 1n ? r.start : MAPPED.end + 1n, end: r.end});
  }
  return {v4: size(inside), v6: size(outside)};
}
// --trustProxy trusts at most an IPv4 /8 and an IPv6 /32 (the high review of
// #483, 8): wider, and a client on the open internet is likely inside it,
// its own X-Forwarded-For believed
const TRUST_MAX_V4 = 1n << 24n;
const TRUST_MAX_V6 = 1n << 96n;
// --unauthRateLimit's default (lib/unauth-limit.js reads the option only)
const UNAUTH_RATE_LIMIT_DEFAULT = 30;
// --trustProxy's hop count at most: more than any real chain of proxies,
// and one past the real chain lets a client name its own address
const TRUST_PROXY_MAX_HOPS = 10;
// --maxOutputBytes at most (lean worker step 2): a hop result is one buffer this size.
const MAX_OUTPUT_BYTES_CEILING = 268435456;
// setTimeout's largest delay: past it Node fires at once (TimeoutOverflowWarning)
const MAX_TIMER_MS = 2147483647;

// minimist gives a flag given twice with string values as an array
// (`--stdio=true --stdio=true` is ['true', 'true']), which every boolean test
// below would read as false. A repeated boolean flag counts by its last
// value, as with one given once (#124). Options that may be repeated
// (--loadModule) are left as they are. Every flag setOptions tests as a
// boolean is in this list (test/stdio/02 checks it against this file).
// --moduleQuestions takes on or off, and true or false with them: one value,
// the last, as these are. Left a list, it would be "a value it does not
// know", and --hardened --moduleQuestions off would not start.
const BOOLEAN_FLAGS = ['debug', 'heapDump', 'workerThread',
  'directPeerChannels', 'meter', 'stdio', 'authoringTools', 'hardened', 'settingsTool', 'moduleRegistry', 'moduleQuestions', 'testLateLoads'];
function lastOfRepeated(argv) {
  const out = Object.assign({}, argv);
  for (const k of BOOLEAN_FLAGS) if (Array.isArray(out[k])) out[k] = out[k][out[k].length - 1];
  return out;
}

// What a worker reads of the options, and so all it is sent (F4-8, #194's
// PR 3): the fields read in the boot closures of lib/lean-worker.js and
// lib/validator-worker.js (sandbox 67's walk). A host path of the
// operator's (modulePath, moduleDataPath, authConfigPath, sessionDir, the
// store's, a settings file) never reaches a worker, where module code
// could read it. A field a worker comes to read is added here, with
// test/validation/10. Two are carried that no runtime code in a worker
// reads: jobTimeout and jobResultTtl, which jobs (main-thread only) use;
// #112 has a worker's options hold the main thread's durations, in
// milliseconds, as a whole, with requestTimeout (test/composition/18), and
// neither is a host path. mcpToolCallCost, the billing cost, is read only
// on the main thread (CHUtil.ci, which a worker hasn't), so it is not sent.
const WORKER_OPTIONS = Object.freeze(['bindAddr', 'debug', 'directPeerChannels', 'directPeerChannelsMaxConcurrency', 'jobResultTtl',
  'jobTimeout', 'locale', 'maxOutputBytes', 'moduleSandbox', 'outputCeiling', 'requestTimeout', 'settingsTool', 'workerThread']);

module.exports = {
  WORKER_OPTIONS,
  // (test/helpers/job-queue.js: a runtime's data directory when none is given)
  defaultModuleDataPath,
  BOOLEAN_FLAGS: BOOLEAN_FLAGS,
  ipGroups,
  UNAUTH_RATE_LIMIT_DEFAULT,

  // how.resolved: the options are a getOptions() (a worker's, from the main
  // thread), whose durations are already in milliseconds (#112); use
  // setResolvedOptions. Otherwise they are the CLI's, durations in seconds.
  setOptions: function(argv, how) {
    const resolved = (how != null && how.resolved === true);
    argv = lastOfRepeated(argv);
    this.debug                   = (argv.debug           === true) ? true : false;
    // a dev aid: needs node --expose-gc (bin/countinghouse passes it)
    this.heapDump                = (argv.heapDump        === true) ? true : false;

    // On unless turned off (8.0.0). minimist gives `--workerThread false` and
    // `--workerThread=false` as the string "false", which means off too.
    this.workerThread            = (argv.workerThread !== false && argv.workerThread !== 'false');

    // On unless the operator passes --no-directPeerChannels (7.1.0; it was
    // opt-in before). When off, lib/service-client.js's isRemoteThread
    // branch is byte-for-byte the main-thread-routed path -- this flag
    // changes nothing about either path's behavior, only which path is
    // taken. `!== false` rather than `=== true` so that the absence of the
    // flag means on, and so that the already-resolved boolean a worker
    // receives from getOptions() below round-trips unchanged.
    // `--directPeerChannels false` and `=false` arrive as the string "false":
    // off too, as for --workerThread (the review of #90).
    this.directPeerChannels      = (argv.directPeerChannels !== false && argv.directPeerChannels !== 'false');
    // --moduleQuestions off: no module's ctx.ask reaches a user (the MCP
    // completeness design, section 8); every ask is then ASK_UNAVAILABLE,
    // which a module may catch to fall back. On unless turned off.
    // A value it does not know stops the start (framework.js), and until
    // then reads as off: never on by a value that could not be read.
    const askOn = argv.moduleQuestions === undefined || argv.moduleQuestions === true || argv.moduleQuestions === 'on' || argv.moduleQuestions === 'true';
    const askOff = argv.moduleQuestions === false || argv.moduleQuestions === 'off' || argv.moduleQuestions === 'false';
    this.moduleQuestions         = askOn;
    this.moduleQuestionsInvalid  = (askOn || askOff) ? null : {name: 'moduleQuestions', value: argv.moduleQuestions, what: 'on or off'};
    // Whether the operator named --directPeerChannels: the single-identity
    // profile refuses it (lib/local-profile.js), and only the main thread reads
    // it. A worker's options are rebuilt from getOptions()'s resolved boolean,
    // so there it says only whether peer channels are on.
    this.directPeerChannelsGiven = argv.directPeerChannels !== undefined && argv.directPeerChannels !== false && argv.directPeerChannels !== 'false';

    // Backpressure cap for lib/peer-channel.js (see its maxConcurrentInvokes
    // comment) -- how many peer-invoke calls a single channel will have in
    // flight, on both the sending and receiving side, before queueing the
    // rest. Fixes the regression docs/direct-peer-channels.md's benchmark
    // found at large payloads under high concurrency (direct peer channels
    // losing to the main-thread-routed path because nothing throttled how
    // much work piled up). See that doc's "Backpressure" section for why
    // this default was chosen.
    this.directPeerChannelsMaxConcurrency = argv.directPeerChannelsMaxConcurrency != null
      ? parseInt(argv.directPeerChannelsMaxConcurrency)
      : 16;

    // How often lib/peer-channel-broker.js re-runs the authorization check
    // for the grants behind open peer channels, so that a grant revoked
    // while the server runs closes the channel it opened. 0 turns the
    // re-check off, which restores the pre-7.1.0 behaviour: an open channel
    // then outlives a revocation until its worker restarts.
    this.peerChannelAuthRecheckSeconds = argv.peerChannelAuthRecheckSeconds != null
      ? Number(argv.peerChannelAuthRecheckSeconds)
      : 5;
    if (!(this.peerChannelAuthRecheckSeconds >= 0)) this.peerChannelAuthRecheckSeconds = 5;
    // How long one of those re-check lookups may take before the channel it
    // guards is closed as unconfirmed (R2-1 Task 3, the reviewer's M13): an
    // auth backend that accepts the lookup and never answers must not leave
    // a channel open, nor the re-check stuck in flight.
    this.peerChannelAuthLookupTimeoutMs = argv.peerChannelAuthLookupTimeoutMs != null
      ? Number(argv.peerChannelAuthLookupTimeoutMs)
      : 10000;
    if (!(this.peerChannelAuthLookupTimeoutMs > 0)) this.peerChannelAuthLookupTimeoutMs = 10000;

    this.modulePath   = argv.modulePath || `${process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME']}/countinghouse_modules`;
    // Each module's private /data and /tmp (module sandbox part 2). Not
    // $HOME/countinghouse_module_data: a name that extends a likely install
    // directory ($HOME/countinghouse) is one Node's permission model mishandles
    // under --hardened (nodejs/node#66812).
    // in the host's separators (on Windows a mixed C:\Users\x/.countinghouse
    // was named so in every message)
    this.moduleDataPath = argv.moduleDataPath || defaultModuleDataPath();
    // The backends' connection strings default on the main thread only: a
    // worker receives none (getOptionsForWorker) and must not invent one.
    this.dbUrl        = argv.dbUrl      || (isMainThread ? 'http://admin:12345678@127.0.0.1:5984' : null);
    // A string: minimist gives an all-digit value as a number, which never
    // equals the X-CH-Key header (review). A bare --debugKey is true to
    // minimist, and must not become the key 'true': debugKeyMissing makes
    // framework.js refuse to start (review R1-5b).
    const dk = argv.debugKey;
    this.debugKeyMissing = (dk != null && typeof(dk) !== 'string' && typeof(dk) !== 'number') || dk === '';
    this.debugKey     = (!this.debugKeyMissing && dk != null) ? String(dk) : null;

    // AuthProvider selection (lib/auth/index.js) -- 'file' (default, no
    // external dependency), 'sqlite' (also no external service, just a
    // local db file), or 'couchdb' (lib/couchdb-adapter/, requires nano +
    // a real CouchDB instance, --dbUrl above). authConfigPath is the
    // backend-specific config file location: auth.json for 'file',
    // the sqlite db file for 'sqlite'; unused for 'couchdb'.
    this.authProvider   = argv.authProvider   || 'file';
    this.authConfigPath = argv.authConfigPath || null;

    // Directory holding one <moduleName>.json file per module with
    // device config to preload (lib/device-config.js, replaces the old
    // CouchDB device-config db). Defaults to ./config/devices relative to
    // cwd; a missing directory/file is not an error, just an empty config.
    this.deviceConfigPath = argv.deviceConfigPath || null;

    // it is weird that on error condition, redis url which the ip is accessible would return ECONNREFUSED, but unaccessible ip won't report any error
    // A module's worker has no redisUrl property at all (R2-1 Task 5): it
    // opens no connection, and module code shares its realm.
    if (isMainThread) this.redisUrl = argv.redisUrl || 'redis://127.0.0.1:6379';
    this.redisUrlExplicit = (argv.redisUrl != null);

    // Where the runtime keeps what it used Redis for (LM1, docs/superpowers/
    // specs/2026-11-11-local-mode-design.md section 1): redis (the default,
    // as before) or local, files under --storePath (default beside the
    // module data, <moduleDataPath>/../store). --meter keeps today's
    // balances and limits in --store local. framework.js refuses a --store
    // it does not know, and --store local with --redisUrl.
    this.store        = (argv.store != null) ? String(argv.store) : 'redis';
    this.storePath    = path.resolve((argv.storePath != null) ? String(argv.storePath) : path.join(this.moduleDataPath, '..', 'store'));
    this.meter        = (argv.meter === true);
    // --store local keeps no Redis: no URL to connect to, and none for the
    // module sandbox to deny (the spec: the always-denied endpoint list is
    // empty in local).
    if (this.store === 'local' && isMainThread) this.redisUrl = null;

    // The single-identity profile (LM1 spec section 4): --store local
    // --stdio without --authConfigPath. Its key is this process's own, made
    // here on the main thread and held in memory only: never printed,
    // logged or written, and kept out of getOptions() and every copy a
    // worker gets (C's stdio layer reads options.apiKey on the main thread).
    // An explicit --authProvider (sqlite, couchdb, even file) is the
    // operator's choice of tenants and turns the profile off, as any
    // --authConfigPath does (one given with no path is refused at start,
    // authConfigPathInvalid, rather than falling into the zero-config file).
    this.authConfigPathInvalid = (argv.authConfigPath === true || argv.authConfigPath === '');
    // --sessionSocket <path> (the shared runtime, C1): MCP sessions over a
    // Unix socket in <home>/run/daemon, from ch-local's shim, instead of
    // stdio; on Windows (C2) a named pipe, \\.\pipe\countinghouse-<32 hex>,
    // kept as given (a pipe name is no path to resolve; on POSIX it is then
    // refused at start). Like --stdio it is the single-identity profile;
    // unlike it, the runtime doesn't end when its stdin does. Needs
    // --controlChannel ipc (ch-local daemon); exclusive with --stdio and
    // --port (framework.js).
    const pipeForm = (v) => /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(v);
    this.sessionSocket = (typeof(argv.sessionSocket) === 'string' && argv.sessionSocket !== '')
      ? (pipeForm(argv.sessionSocket) ? argv.sessionSocket : path.resolve(argv.sessionSocket)) : null;
    // a bare --sessionSocket (no path) parses as a boolean: refused
    this.sessionSocketInvalid = (typeof(argv.sessionSocket) === 'boolean' || argv.sessionSocket === '');
    // --sessionDir <path> (C2): the directory of the secret and the runtime's
    // lock, <home>/run/daemon. Required with a named pipe, which has no
    // directory; on POSIX the socket's own directory when not given, and
    // given only for the long-home fallback, where the socket is in
    // $TMPDIR/ch-<uid>/ and the secret stays in <home>/run/daemon.
    this.sessionDir = (typeof(argv.sessionDir) === 'string' && argv.sessionDir !== '') ? path.resolve(argv.sessionDir) : null;
    this.sessionDirInvalid = (typeof(argv.sessionDir) === 'boolean' || argv.sessionDir === '');
    // on Windows a drive path only (#275 review): no UNC or device path, so the
    // secret is never on another machine's share
    this.sessionDirNotDrive = process.platform === 'win32' && this.sessionDir != null && !require('./win-acl').DRIVE_PATH.test(this.sessionDir);
    this.sessionWithPort = this.sessionSocket != null && argv.port != null;
    this.singleIdentity = (this.store === 'local' && (argv.stdio === true || argv.stdio === 'true' || this.sessionSocket != null) && argv.authConfigPath == null && argv.authProvider == null);
    // Made once per process and read-only: the cached auth provider and
    // the identity index hold it (review of B4).
    if (this.singleIdentity && isMainThread) {
      if (typeof(this.apiKey) !== 'string') {
        Object.defineProperty(this, 'apiKey', {value: `local-${require('crypto').randomBytes(16).toString('hex')}`,
          enumerable: false, writable: false, configurable: true});
      }
    } else {
      delete this.apiKey;
    }

    this.bindAddr     = argv.bindAddr   || null;
    this.port         = argv.port       || '9527';

    // --stdio: MCP over stdin and stdout instead of HTTP (local-mode spec §2).
    // Exclusive with --port (framework.js refuses both).
    this.stdio        = argv.stdio === true || argv.stdio === 'true';
    // --controlChannel ipc (packs in place, part 2): ch-local start's channel
    // to this runtime. Any other value is refused; so is ipc outside the
    // single-identity profile, without an IPC fd, or under --hardened
    // (framework.js).
    this.controlChannel = (argv.controlChannel != null) ? String(argv.controlChannel) : null;
    // The in-place flags given at all, whatever their value (a bare or empty
    // one included): --hardened refuses them by this (framework.js)
    this.inPlaceFlagsGiven = ['controlChannel', 'modulesRoot'].filter((k) => argv[k] != null);
    // --packsRoot went with the pack form (M6): given, the start stops
    // (framework.js), so an old launcher is never silently half-applied
    this.packsRootGiven = argv.packsRoot != null;
    // --modulesRoot <dir> (module-level configuration, M4; #413 section
    // 7.2): where a module the control channel loads may be, ch-local's
    // <home>/module-store. A module-form request's directories (`dirs`) must
    // each lie inside one by real path, with no link out
    // (lib/modules-in-place.js); with none, the channel loads no module in
    // the module form. Repeatable.
    this.modulesRoot = [].concat(argv.modulesRoot != null ? argv.modulesRoot : [])
      .filter((d) => typeof(d) === 'string' && d !== '').map((d) => path.resolve(d));
    // --partDir <dir> (M4; #413 section 7.2): the directory of a part the
    // start loads (ch-local passes one per part of its start plan). Only
    // with --modulesRoot, which it must lie inside; a called part is then
    // looked for only among these and the --loadModule directories.
    // Repeatable.
    this.partDir = [].concat(argv.partDir != null ? argv.partDir : [])
      .filter((d) => typeof(d) === 'string' && d !== '').map((d) => path.resolve(d));
    this.stdioWithPort = this.stdio && argv.port != null;
    // --settingsFile <path> (packs in place, part 2): ch-local's
    // <home>/settings.json, which countinghouse_settings changes (lib/settings-tool.js).
    // Only in the single-identity profile: the tool is listed nowhere else.
    this.settingsFile = (typeof(argv.settingsFile) === 'string' && argv.settingsFile !== '') ? path.resolve(argv.settingsFile) : null;
    // a bare --settingsFile (no path) parses as a boolean: refused (framework.js)
    this.settingsFileInvalid = (typeof(argv.settingsFile) === 'boolean' || argv.settingsFile === '');
    // --moduleSettings <file> (module settings, section 4.7): an operator's
    // modules' settings, {"<package>": {"<setting>": value}}, read at each
    // load, never written by the runtime; not beside --settingsFile, which
    // holds ch-local's (lib/module-settings.js)
    // One path: a number-like name (minimist has made 007, 1e3 or 0x10 a
    // number) is taken as the text given on the command line; given twice
    // (an array), bare, or empty, the start is refused rather than run
    // without the operator's settings.
    const ms = (typeof(argv.moduleSettings) === 'number') ? rawFlagText('moduleSettings', argv.moduleSettings) : argv.moduleSettings;
    this.moduleSettings = (typeof(ms) === 'string' && ms !== '') ? path.resolve(ms) : null;
    this.moduleSettingsInvalid = (ms !== undefined && this.moduleSettings == null);
    // whether the settings tool is served, so a size cap's error can tell the
    // agent to raise the cap with it (lib/call-limits.js raiseHint). On the
    // main thread: a --settingsFile in the single-identity profile, the only
    // place the tool is served (framework.js refuses it elsewhere; never on
    // a flag of its own). A worker takes the main thread's answer from its
    // options, never the file's path.
    this.settingsTool = isMainThread
      ? (this.singleIdentity === true && this.settingsFile != null)
      : (argv.settingsTool === true || argv.settingsTool === 'true');
    this.outputCeiling = (argv.outputCeiling === null || Number.isInteger(argv.outputCeiling)) ? argv.outputCeiling : undefined;

    // --usageDir <dir>: where the usage records are appended, one file per
    // process per day (local-mode spec §5). Under --store local it defaults to
    // <storePath>/usage, so every launcher sharing a store writes one record of
    // usage across agents (reviewer, 2026-11-12); under --store redis it is
    // explicit-only, a hosted operator opting in to disk writes. Unset, nothing
    // is written; the counters, the receipt and the report's memory source
    // still work.
    this.usageDir     = typeof argv.usageDir === 'string' && argv.usageDir !== '' ? argv.usageDir
      : (this.store === 'local' ? path.join(this.storePath, 'usage') : null);

    this.locale       = argv.locale || 'en-US';

    this.globalRateLimit = argv.globalRateLimit != null ? parseInt(argv.globalRateLimit) : null;
    // per-apiKey rate limit (max calls/second per caller), via
    // MeteringProvider.rateLimit -- separate from and additional to
    // globalRateLimit above, which caps the combined call rate across every
    // caller. Opt-in, off by default, so it never changes behavior for a
    // deployment/test run that doesn't set it.
    this.apiKeyRateLimit = argv.apiKeyRateLimit != null ? parseInt(argv.apiKeyRateLimit) : null;

    // Requests whose API key doesn't resolve (lib/unauth-limit.js): at most
    // this many refused per minute per client address, then 429 for that
    // address (0 turns it off; 30 by default). A whole number >= 0, or
    // framework.js exits 2.
    const unauth = argv.unauthRateLimit;
    const unauthOk = unauth == null || (typeof(unauth) === 'number' && Number.isInteger(unauth) && unauth >= 0);
    this.unauthRateLimitInvalid = unauthOk ? null : {value: unauth};
    this.unauthRateLimit = (unauthOk && unauth != null) ? unauth : UNAUTH_RATE_LIMIT_DEFAULT;
    // The client's address behind a proxy: Express's 'trust proxy', a number
    // of proxy hops or a comma list of the proxies' addresses or CIDRs, and
    // X-Forwarded-For read through it (req.ip). Only behind a proxy the
    // operator controls: otherwise X-Forwarded-For is the client's to forge.
    // None by default (the socket's address); a bare --trustProxy, or one
    // trusting every hop (true, more than TRUST_PROXY_MAX_HOPS hops, ranges
    // covering more than an IPv4 /8 or an IPv6 /32 together), is refused
    // (framework.js exits 2). Express's names for private ranges stand. A hop count is only right when it is
    // the real number of proxies in front: one more, and the client's own
    // X-Forwarded-For entry is believed.
    const tp = argv.trustProxy;
    this.trustProxy = null;
    this.trustProxyInvalid = null;
    if (tp != null) {
      // a hop count: a number, or its digits (a value set other than by the
      // command line)
      const hops = typeof(tp) === 'number' ? tp : (typeof(tp) === 'string' && /^\d+$/.test(tp.trim()) ? Number(tp.trim()) : null);
      if (hops != null && Number.isInteger(hops) && hops >= 1 && hops <= TRUST_PROXY_MAX_HOPS) this.trustProxy = hops;
      else if (hops != null) this.trustProxyInvalid = {value: tp, why: `at most ${TRUST_PROXY_MAX_HOPS} hops`};
      else if (typeof(tp) === 'string' && tp.trim() !== '' && !/^(true|false)$/i.test(tp.trim())) {
        const list = tp.split(',').map((x) => x.trim()).filter((x) => x !== '');
        const ranges = list.map(trustedProxyRange);
        const bad = list.find((x, i) => ranges[i] == null);
        const wide = coverage(ranges.filter((r) => r != null && r !== 'named'));
        if (bad != null) this.trustProxyInvalid = {value: tp, why: `${JSON.stringify(bad)} is not an address, a CIDR or loopback/linklocal/uniquelocal`};
        else if (list.length === 0) this.trustProxyInvalid = {value: tp};
        else if (wide.v4 > TRUST_MAX_V4 || wide.v6 > TRUST_MAX_V6) this.trustProxyInvalid = {value: tp, why: 'it trusts more than an IPv4 /8 or an IPv6 /32, in any spelling'};
        else this.trustProxy = list;
      } else this.trustProxyInvalid = {value: tp};
    }

    // cost recorded via MeteringProvider.recordCall for every MCP tools/call
    // (both synchronous and task-augmented). Defaults to 0: calls are still
    // recorded (toolPriceRecord/balance bookkeeping runs either way), but
    // nothing is actually charged unless this is set to a positive value.
    // A finite number >= 0 only (review M9): a negative cost credits every
    // caller, NaN or Infinity make recordCall fail and the call is served
    // free, and parseFloat read "1abc" as 1. minimist has already turned a
    // numeric value into a number; anything else (a word, an empty value, no
    // value at all, "--mcpToolCallCost -1", which minimist reads as no value)
    // is kept in mcpToolCallCostInvalid, and framework.js exits 2.
    const cost = argv.mcpToolCallCost;
    const costOk = (cost == null) || (typeof(cost) === 'number' && Number.isFinite(cost) && cost >= 0);
    this.mcpToolCallCostInvalid = costOk ? null : {value: cost};
    this.mcpToolCallCost = (costOk && cost != null) ? cost : 0;

    // RC1-min (lib/remote/): the operator's credential allowance, which
    // framework.js loads at start (exit 2 when it is not the documented
    // shape), and the limits on a remote call: seconds, and bytes of one
    // answer. A limit that is not a positive finite number is kept in
    // remoteLimitInvalid, and framework.js exits 2.
    // minimist reads an all-digit path as a number, as it does --debugKey.
    const rc = argv.remoteCredentials;
    this.remoteCredentials = (typeof(rc) === 'string' || typeof(rc) === 'number') ? String(rc) : null;
    const positive = (v) => typeof(v) === 'number' && Number.isFinite(v) && v > 0;
    this.remoteTimeout  = (argv.remoteTimeout  != null) ? argv.remoteTimeout  : 60;
    this.remoteMaxBytes = (argv.remoteMaxBytes != null) ? argv.remoteMaxBytes : 16777216;
    // --remoteOriginMap <declared https origin>=<http://127.0.0.1:port | http://[::1]:port>
    // (acceptance runs only): the option as given, nothing more. framework.js
    // parses it, checks it and fixes the map at start in lib/remote/origin-map.js,
    // which the registry reads: never this object, which anything can write.
    // A string option (repeatable), not a boolean: --no-remoteOriginMap means
    // none; a bare --remoteOriginMap (no value) is kept, and refused at start.
    const rom = argv.remoteOriginMap;
    this.remoteOriginMapArg = (typeof(rom) === 'string' || Array.isArray(rom) || (rom != null && !!rom)) ? rom : null;
    this.remoteLimitInvalid = !positive(this.remoteTimeout) ? {name: 'remoteTimeout', value: this.remoteTimeout}
      : (!positive(this.remoteMaxBytes) ? {name: 'remoteMaxBytes', value: this.remoteMaxBytes} : null);

    // Lean worker step 1(b) (lib/validator-pool.js): how many validator
    // workers validate modules' inputs and outputs, and how long one request
    // may take before its worker is replaced and the call refused
    // VALIDATION_TIMEOUT. A value that is not a positive integer (workers) or
    // a positive number (milliseconds) is kept in validatorLimitInvalid, and
    // framework.js exits 2.
    // --validationCompileMs: compiling a module's schemas (at load, and an
    // action's again after a validator is replaced) has its own budget, past
    // which the load is refused (MODULE_ASSEMBLY_FAIL, stage schemaCompile).
    // --maxOutputBytes: a module's reply, measured in its own worker before it
    // is posted, past which the call is refused OUTPUT_TOO_LARGE. One cap for
    // every module output, a hop's result included (lean worker step 2, the
    // reviewer's ruling of 2026-11-13); at most 256 MiB, since a hop result
    // crosses as one buffer that size.
    // the default: one per spare CPU, 2 to 4 (the review of #165)
    this.validatorWorkers    = (argv.validatorWorkers != null) ? argv.validatorWorkers : Math.max(2, Math.min(4, require('os').cpus().length - 1));
    this.validationTimeoutMs = (argv.validationTimeoutMs != null) ? argv.validationTimeoutMs : 1000;
    this.validationCompileMs = (argv.validationCompileMs != null) ? argv.validationCompileMs : 10000;
    this.maxOutputBytes      = (argv.maxOutputBytes != null) ? argv.maxOutputBytes : 16777216;   // 16 MiB (decided 2026-11-15)
    const positiveInteger = (v) => Number.isInteger(v) && v > 0;
    this.validatorLimitInvalid = !positiveInteger(this.validatorWorkers) ? {name: 'validatorWorkers', value: this.validatorWorkers, what: 'a positive integer'}
      : !positive(this.validationTimeoutMs) ? {name: 'validationTimeoutMs', value: this.validationTimeoutMs, what: 'a positive number'}
        : !positive(this.validationCompileMs) ? {name: 'validationCompileMs', value: this.validationCompileMs, what: 'a positive number'}
          : !(positiveInteger(this.maxOutputBytes) && this.maxOutputBytes <= MAX_OUTPUT_BYTES_CEILING)
            ? {name: 'maxOutputBytes', value: this.maxOutputBytes, what: `a positive integer, at most ${MAX_OUTPUT_BYTES_CEILING}`} : null;

    // The result store (MCP completeness M5, lib/store/blobs.js; spec section
    // 2): --resourceRetention in seconds, 24 h by default, from 1 minute to 7
    // days; --resourceStoreBytes and --resourceQuotaBytes default by the store
    // (null here: lib/store/blobs.js limitsFromOptions has the defaults);
    // --resourceQuotaItems 1024. Anything else exits 2 at start.
    this.resourceRetention  = (argv.resourceRetention != null) ? argv.resourceRetention : 86400;
    this.resourceStoreBytes = (argv.resourceStoreBytes != null) ? argv.resourceStoreBytes : null;
    this.resourceQuotaBytes = (argv.resourceQuotaBytes != null) ? argv.resourceQuotaBytes : null;
    this.resourceQuotaItems = (argv.resourceQuotaItems != null) ? argv.resourceQuotaItems : 1024;
    // M6: the inline budget, decoded bytes per result (1 MiB; 0 links every
    // binary value), and the metering cost of one resources/read (0)
    this.inlineContentBytes = (argv.inlineContentBytes != null) ? argv.inlineContentBytes : 1024 * 1024;
    this.resourceReadCost   = (argv.resourceReadCost != null) ? argv.resourceReadCost : 0;
    const wholeNumber = (v) => Number.isInteger(v) && v >= 0;
    this.resourceLimitInvalid = !wholeNumber(this.inlineContentBytes) ? {name: 'inlineContentBytes', value: this.inlineContentBytes, what: 'a whole number of bytes (0 links every binary value)'}
      : !wholeNumber(this.resourceReadCost) ? {name: 'resourceReadCost', value: this.resourceReadCost, what: 'a whole number (0, the default, meters nothing)'}
      : !(Number.isInteger(this.resourceRetention) && this.resourceRetention >= 60 && this.resourceRetention <= 604800)
      ? {name: 'resourceRetention', value: this.resourceRetention, what: 'a whole number of seconds from 60 (1 minute) to 604800 (7 days)'}
      : (this.resourceStoreBytes != null && !positiveInteger(this.resourceStoreBytes)) ? {name: 'resourceStoreBytes', value: this.resourceStoreBytes, what: 'a positive integer'}
        : (this.resourceQuotaBytes != null && !positiveInteger(this.resourceQuotaBytes)) ? {name: 'resourceQuotaBytes', value: this.resourceQuotaBytes, what: 'a positive integer'}
          : !positiveInteger(this.resourceQuotaItems) ? {name: 'resourceQuotaItems', value: this.resourceQuotaItems, what: 'a positive integer'}
            // the result store's files must never be where a module can reach
            // them; checked on the main thread only, where the store is: a
            // module's worker sets these options too, and loads a fixed list
            // of files (test/sandbox/43), which this one is not on
            : (isMainThread && this.store === 'local' && require('./store/resources-path').resourcesProblem(this.storePath, this.moduleDataPath) != null)
              ? {name: 'storePath', value: this.storePath, what: 'outside --moduleDataPath (the result store, <storePath>/resources, must not be reachable by a module)'} : null;

    // MCP completeness M1 (spec section 5, lib/mcp/pages.js): how many items
    // one page of a list holds, 250 by default, from 10 to 1000. A client
    // can't choose it. Anything else exits 2 at start.
    this.listPageSize = (argv.listPageSize != null) ? argv.listPageSize : 250;
    this.listPageSizeInvalid = (Number.isInteger(this.listPageSize) && this.listPageSize >= 10 && this.listPageSize <= 1000) ? null
      : {name: 'listPageSize', value: this.listPageSize, what: 'a whole number from 10 to 1000'};

    // R1 (shared runtime, per-session modules; #236 section 4a): how many
    // per-session workers run at once, in all (every module, every session),
    // 16 by default. The operator's only: never a setting a session can
    // change. At the cap the least recently used idle one gives up its slot
    // (lib/session-workers.js). Anything but a positive integer exits 2.
    this.maxSessionWorkers = (argv.maxSessionWorkers != null) ? argv.maxSessionWorkers : 16;
    this.maxSessionWorkersInvalid = (Number.isInteger(this.maxSessionWorkers) && this.maxSessionWorkers >= 1) ? null
      : {name: 'maxSessionWorkers', value: this.maxSessionWorkers, what: 'a positive integer'};

    if (argv.loadModule != null) {
      this.localModulePath = argv.loadModule;
    }
    // --moduleRegistry: the CDIF-era module registry (lib/device-db, sqlite3),
    // opt-in. Only with it does a start with no --loadModule read the
    // registry and load what it lists from --modulePath. Without it such a
    // start loads nothing and serves the platform tools: sqlite3 is optional,
    // and absent from a ch-local install, whose start with no pack crashed
    // on the registry before it listened (#54).
    this.moduleRegistry = argv.moduleRegistry === true || argv.moduleRegistry === 'true';

    this.deviceLogEntrySize = argv.deviceLogEntrySize || 1000;

    // Durations: --requestTimeout, --jobTimeout and --jobResultTtl are given
    // in seconds and held in milliseconds; resolved options (a worker's,
    // setResolvedOptions) carry them in milliseconds already and keep them
    // so. One conversion, here (#112: a worker multiplied them by 1000 a
    // second time). A flag with no number (--no-x, a bare --x: minimist's
    // booleans), or one repeated (an array), is the default, as before; every
    // value is capped at setTimeout's largest delay, past which Node fires
    // at once.
    const duration = (v, dflt, min) => {
      if (typeof(v) !== 'number' && (typeof(v) !== 'string' || v.trim() === '')) return dflt;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min) return dflt;
      return Math.min(MAX_TIMER_MS, Math.ceil(resolved ? n : n * 1000));
    };

    // --requestTimeout <seconds>: the request timer; also a direct peer
    // channel hop's timeout in a worker (lib/device-manager.js). Any finite
    // value, as before: 0 or less expires at once (lib/timer.js).
    this.requestTimeout = duration(argv.requestTimeout, 30000, -Infinity);
    // --jobTimeout <seconds>: how long the job processor lets a job run when
    // it sets no timeout of its own (lib/job-control.js), so a handler that
    // never answers cannot hold a job worker slot forever. 0 means none.
    this.jobTimeout = duration(argv.jobTimeout, 3600000, 0);
    // --jobResultTtl <seconds>: how long the local job runner (--store local)
    // keeps a finished job's result (ms here, like jobTimeout); default an
    // hour. The BullMQ runner keeps its own (Redis) policy.
    this.jobResultTtl = duration(argv.jobResultTtl, 3600000, 0);

    // Request bodies are read before any route checks the caller's key, so
    // their size is bounded (MB): JSON and XML bodies, app-wide
    // (lib/route-manager.js; review R1-1).
    const mb = (v, dflt) => { const n = parseInt(v, 10); return (n > 0) ? n : dflt; };
    this.maxRequestBody     = mb(argv.maxRequestBody, 8);
    // Browser origins allowed cross-origin access (CORS) and on /mcp; none by
    // default (review R1-2b; user decision, 2026-11-04). Comma-separated.
    this.allowedOrigins = String(argv.allowedOrigins || '').split(',').map((o) => o.trim()).filter((o) => o !== '');

    // Default-off admin-gated MCP authoring tools (lib/mcp/tool-registry.js's
    // AUTHORING_TOOLS, gated in lib/mcp/gateway.js). This is not precautionary:
    // countinghouse_load_module requires() a caller-supplied path directly in
    // the main gateway process, unsandboxed, to load it into the live
    // runtime -- this flag, plus the admin-key gate beneath it, is the only
    // thing standing between a caller and that. (countinghouse_validate_module
    // runs caller-supplied code too, but in a spawned child process instead --
    // see gateway.js's validateModuleInChildProcess comment for the full
    // picture of what each of the four authoring tools does and doesn't
    // protect against.)
    this.authoringTools          = (argv.authoringTools  === true) ? true : false;
    // Test-only (#194's PRs 1 and 2, test/sandbox/66 and 68): each module
    // worker records what the runtime loads after its lockdown and hands
    // the test's fixtures the runtime's modules. The operator's explicit
    // flag, never an environment variable a client or a launcher could
    // pass on; refused with --hardened (framework.js).
    this.testLateLoads           = (argv.testLateLoads === true) ? true : false;

    // Module sandbox (docs/superpowers/specs/2026-10-15-module-sandbox-
    // foundation-design.md). The default depends on --workerThread because
    // the sandbox only exists in worker mode; moduleSandboxExplicit lets
    // framework.js refuse an explicit audit/enforce without it while quietly
    // downgrading the default. A worker receives the already-resolved mode
    // through getOptions(), which counts as explicit there -- harmless, the
    // worker never applies this check.
    this.moduleSandboxExplicit = (argv.moduleSandbox != null);
    this.moduleSandbox = this.moduleSandboxExplicit
      ? String(argv.moduleSandbox)
      : (this.workerThread === true ? 'audit' : 'off');
    this.modulePolicy = argv.modulePolicy || null;
    // How long a module's worker may take to answer its load, in seconds
    // (#144): past it the worker is ended and the load fails
    // MODULE_LOAD_TIMEOUT, in every sandbox mode. Generous: a slow load that
    // does not block (brokered file I/O over a large node_modules) must not
    // trip it. The main thread's alone (getOptionsForWorker leaves it out).
    // A number > 0 that setTimeout can hold (2^31-1 ms; past it Node fires
    // at once) only: minimist has already turned a numeric value into a
    // number, and anything else (a word, no value at all, 0) is kept in
    // moduleLoadTimeoutInvalid, and framework.js exits 2, as for
    // --mcpToolCallCost.
    const load = argv.moduleLoadTimeout;
    const loadOk = (load == null) || (typeof(load) === 'number' && Number.isFinite(load) && load > 0 && load * 1000 <= 2147483647);
    this.moduleLoadTimeoutInvalid = loadOk ? null : {value: load};
    this.moduleLoadTimeoutMs = (loadOk && load != null) ? Math.round(load * 1000) : 120000;
    this.moduleMessageRate = argv.moduleMessageRate != null ? parseInt(argv.moduleMessageRate) : 2000;
    if (!(this.moduleMessageRate > 0)) this.moduleMessageRate = 2000;
    this.hardened = (argv.hardened === true);
  },

  // What the start line logs (framework.js), reviewer, 2026-11-13: --dbUrl
  // only under --authProvider couchdb, and no credential in any URL (its
  // default carries one).
  getOptionsForLog: function() {
    const o = this.getOptions();
    if (this.authProvider !== 'couchdb') delete o.dbUrl;
    for (const k of ['dbUrl', 'redisUrl']) {
      if (typeof(o[k]) !== 'string') continue;
      try {
        const u = new URL(o[k]);
        if (u.username !== '' || u.password !== '') { u.username = ''; u.password = ''; o[k] = u.href; }
      } catch (e) {
        o[k] = '(not a URL)';
      }
    }
    return o;
  },

  // What a module worker receives on set-options (lib/module-manager.js):
  // everything but the backends' connection strings (R2-1). A --redisUrl or
  // --dbUrl carrying a password would otherwise reach every module, and a
  // worker opens no connection of its own.
  // A worker's options are the main thread's, resolved: durations in
  // milliseconds, kept as they are (#112). lib/sandbox.js's set-options and
  // the lean worker's call this, never setOptions.
  setResolvedOptions: function(o) {
    return this.setOptions(o, {resolved: true});
  },

  outputCeilingNow: function() {
    if (this.settingsTool !== true) return undefined;
    // (read at call time, as call-limits reads it: a test may stand in for
    // a worker)
    if (threadInfo.isMainThread !== true) return this.outputCeiling;
    try {
      const callLimits = require('./call-limits');
      return callLimits.ceilingBound(require('./settings-tool').cachedCeiling(() => require('./settings-ceiling').readCeiling()));
    } catch (e) {
      return null;
    }
  },

  getOptionsForWorker: function() {
    const all = this.getOptions();
    // the most maxOutputBytes may be set to here, for the worker's size-cap
    // hint (lib/call-limits.js): the operator's ceiling as the main thread
    // reads it when the worker is spawned; null for none allowed
    all.outputCeiling = this.outputCeilingNow();
    // (only what a worker reads, WORKER_OPTIONS: never the store, Redis or
    // a database, the load bound (#144), the test's probe, or a host path)
    const o = {};
    for (const key of WORKER_OPTIONS) if (Object.prototype.hasOwnProperty.call(all, key)) o[key] = all[key];
    return o;
  },

  // Whether this start reads the module registry: --moduleRegistry, and no
  // --loadModule. The one test framework.js, the module manager and
  // --hardened's grants all use. o: an options object (this one's own by
  // default).
  usesModuleRegistry: function(o) {
    const x = (o != null) ? o : this;
    return x.localModulePath == null && x.moduleRegistry === true;
  },

  getOptions: function() {
    return {
      moduleRegistry:           this.moduleRegistry,
      debug:                    this.debug,
      heapDump:                 this.heapDump,
      workerThread:             this.workerThread,
      directPeerChannels:       this.directPeerChannels,
      directPeerChannelsMaxConcurrency: this.directPeerChannelsMaxConcurrency,
      peerChannelAuthRecheckSeconds: this.peerChannelAuthRecheckSeconds,
      modulePath:               this.modulePath,
      moduleDataPath:           this.moduleDataPath,
      dbUrl:                    this.dbUrl,
      redisUrl:                 this.redisUrl,
      store:                    this.store,
      storePath:                this.storePath,
      meter:                    this.meter,
      authProvider:             this.authProvider,
      authConfigPath:           this.authConfigPath,
      deviceConfigPath:         this.deviceConfigPath,
      bindAddr:                 this.bindAddr,
      port:                     this.port,
      stdio:                    this.stdio,
      sessionSocket:            this.sessionSocket,
      sessionDir:               this.sessionDir,
      usageDir:                 this.usageDir,
      locale:                   this.locale,
      deviceLogEntrySize:       this.deviceLogEntrySize,
      requestTimeout:           this.requestTimeout,
      jobTimeout:               this.jobTimeout,
      jobResultTtl:             this.jobResultTtl,
      globalRateLimit:          this.globalRateLimit,
      apiKeyRateLimit:          this.apiKeyRateLimit,
      unauthRateLimit:          this.unauthRateLimit,
      trustProxy:               this.trustProxy,
      mcpToolCallCost:          this.mcpToolCallCost,
      remoteCredentials:        this.remoteCredentials,
      remoteTimeout:            this.remoteTimeout,
      remoteMaxBytes:           this.remoteMaxBytes,
      authoringTools:           this.authoringTools,
      testLateLoads:            this.testLateLoads,
      moduleSandbox:            this.moduleSandbox,
      modulePolicy:             this.modulePolicy,
      moduleSettings:           this.moduleSettings,
      maxOutputBytes:           this.maxOutputBytes,
      settingsTool:             this.settingsTool,
      moduleMessageRate:        this.moduleMessageRate,
      moduleLoadTimeoutMs:      this.moduleLoadTimeoutMs,
      hardened:                 this.hardened
    }
  }
};

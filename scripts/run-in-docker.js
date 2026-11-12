#!/usr/bin/env node
'use strict';
// Runs test files in a throwaway container (test/docker/Dockerfile) that has
// its own Redis and its own network namespace, so the run cannot meet the
// shared Redis, another session's ports or another container's
// (docs/testing.md).
//
//   node scripts/run-in-docker.js [--node 22|24] [<test file> ...]
//
// With files, each is run by mocha with --exit; with none, CI's suite by
// scripts/run-tests.js --ci. The image is built, or reused from the build
// cache, on every call, from the files git lists (tracked, and untracked but
// not ignored, as they are in the working tree now), so nothing .gitignore'd
// (a local auth file, a database, a log) reaches it. Each run builds under a
// tag of its own, so two runs at once never test each other's tree, and
// removes the tag and the container when it ends, however it ends (Ctrl-C
// included). The exit status is the run's.
//
// A rootless Docker's socket (/run/user/<uid>/docker.sock) is used when
// DOCKER_HOST is not set.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {spawn, spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = {'22': '22.16.0', '24': '24'};

function usage(message) {
  if (message != null) process.stderr.write(`run-in-docker: ${message}\n`);
  process.stderr.write('usage: node scripts/run-in-docker.js [--node 22|24] [<test file> ...]\n');
  return 2;
}

function parse(argv) {
  const files = [];
  let node = '24';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--node') node = (i + 1 < argv.length) ? argv[++i] : '';
    else if (argv[i].startsWith('--node=')) node = argv[i].slice('--node='.length);
    else if (argv[i] === '--help' || argv[i] === '-h') return {help: true};
    else files.push(argv[i]);
  }
  return {node, files};
}

// The build context: what git lists in the working tree (tracked, and
// untracked but not ignored), as it is on disk; deleted files and a
// worktree's node_modules link are left out.
function contextFiles() {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  const seen = new Set();
  return r.stdout.split('\0').filter((f) => {
    if (f === '' || seen.has(f) || f === 'node_modules' || f.startsWith('node_modules/')) return false;
    seen.add(f);
    try { return fs.lstatSync(path.join(ROOT, f)).isDirectory() === false; } catch (e) { return false; }
  });
}

function build(env, tag, nodeVersion, files) {
  return new Promise((resolve) => {
    const tar = spawn('tar', ['--null', '-T', '-', '-cf', '-'], {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']});
    const docker = spawn('docker', ['build', '-f', 'test/docker/Dockerfile', '--build-arg', `NODE_VERSION=${nodeVersion}`, '-t', tag, '-'],
      {env: Object.assign({DOCKER_BUILDKIT: '1'}, env), stdio: ['pipe', 'pipe', 'pipe']});
    let output = '';
    for (const s of [tar.stderr, docker.stdout, docker.stderr]) s.on('data', (c) => { output += c; });
    tar.stdout.pipe(docker.stdin);
    tar.stdin.end(files.join('\0') + '\0');
    let tarCode = null;
    tar.on('exit', (code) => { tarCode = code; });
    tar.on('error', (e) => { output += `tar: ${e.message}\n`; });
    docker.on('error', (e) => { output += `docker: ${e.message}\n`; resolve({ok: false, output}); });
    docker.on('exit', (code) => resolve({ok: code === 0 && tarCode === 0, output}));
  });
}

function dockerEnv() {
  const env = Object.assign({}, process.env);
  const rootless = (typeof(process.getuid) === 'function') ? `/run/user/${process.getuid()}/docker.sock` : null;
  if (env.DOCKER_HOST == null && rootless != null && fs.existsSync(rootless)) env.DOCKER_HOST = `unix://${rootless}`;
  return env;
}

async function main(argv) {
  const opts = parse(argv);
  if (opts.help) { usage(); return 0; }
  if (NODE[opts.node] == null) return usage(`--node takes 22 or 24, not ${JSON.stringify(opts.node)}`);
  const context = contextFiles();
  const inContext = new Set(context);
  const files = [];
  for (const f of opts.files) {
    const rel = path.relative(ROOT, path.resolve(f)).split(path.sep).join('/');
    if (!inContext.has(rel)) return usage(`not a file git lists in this tree (so not in the image): ${f}`);
    files.push(rel);
  }
  const env = dockerEnv();
  const name = `ch-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const tag = `countinghouse-test:node${opts.node}-${name}`;
  const removeContainer = () => spawnSync('docker', ['rm', '-f', name], {env, stdio: 'ignore'});
  // Untags this run's image; the image itself goes only if no other tag or
  // container holds it, and the build cache keeps its layers either way.
  const removeTag = () => spawnSync('docker', ['rmi', tag], {env, stdio: 'ignore'});

  // The build's own output is shown only when it fails, so the run's output
  // is the tests'.
  process.stderr.write(`run-in-docker: building Node ${NODE[opts.node]} from ${context.length} files...\n`);
  const built = await build(env, tag, NODE[opts.node], context);
  if (!built.ok) {
    process.stderr.write(built.output);
    process.stderr.write('run-in-docker: the image did not build\n');
    removeTag();
    return 1;
  }

  const command = files.length > 0
    ? ['node', 'node_modules/mocha/bin/mocha.js', '--exit', ...files]
    : ['node', 'scripts/run-tests.js', '--ci'];
  // CH_TEST_PORT_BASE and CH_TEST_REDIS_URL point inside the container
  // (test/helpers/test-env.js); with --network none they could not reach
  // anything outside it anyway.
  const args = ['run', '--rm', '--init', '--name', name, '--network', 'none',
    '-e', 'CH_TEST_PORT_BASE=9800', '-e', 'CH_TEST_REDIS_URL=redis://127.0.0.1:6379', tag, ...command];
  process.stderr.write(`run-in-docker: ${name}: ${command.slice(1).join(' ')}\n`);

  return new Promise((resolve) => {
    const child = spawn('docker', args, {env, stdio: ['ignore', 'inherit', 'inherit']});
    let stopping = false;
    const finish = (code) => {
      removeContainer();
      removeTag();
      resolve(code);
    };
    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`\nrun-in-docker: ${signal}, removing ${name}\n`);
      finish(signal === 'SIGINT' ? 130 : 143);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));
    child.on('error', (err) => {
      process.stderr.write(`run-in-docker: ${err.message}\n`);
      if (!stopping) finish(1);
    });
    // --rm has removed the container by now; removing it again covers a
    // docker run that was itself cut short.
    child.on('exit', (code, signal) => {
      if (!stopping) finish(code != null ? code : (signal != null ? 1 : 0));
    });
  });
}

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code));
}

module.exports = {parse, contextFiles, NODE};

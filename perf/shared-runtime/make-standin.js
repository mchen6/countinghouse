// Builds pack 1 with a STAND-IN ch-access-github, for
// perf/shared-runtime/measure.js: a copy of an installed pack's packages in
// which ch-access-github keeps its name, api.json and schema.json, but its
// four actions answer canned results (one failed run, one failed job, a
// 200-line log, the run's commit) and it declares no remote. Every call of
// the scenario then runs its 11 hops between real modules, offline. The
// installed pack is only read; nothing of it is committed here.
//
//   node perf/shared-runtime/make-standin.js <installed pack's node_modules/@countinghouse> <out dir>
//
// -> <out dir>/node_modules/@countinghouse/<package>, the scenario at
// .../ch-pack-ci-failure-triage (measure.js's --pack).
'use strict';
const fs = require('fs');
const path = require('path');

const PACKAGES = ['ch-pack-ci-failure-triage', 'ch-access-github', 'ch-step-dedupe', 'ch-step-error-patterns', 'ch-step-failure-signature',
  'ch-step-log-clean', 'ch-step-owner-hint', 'ch-step-redact', 'ch-step-report'];
const SHA = '4f1c2e9a7b3d5f60a8e9c1b2d3f4a5b6c7d8e9f0';

function log() {
  const lines = [];
  for (let i = 0; i < 200; i++) {
    const t = `2026-11-14T10:00:${String(i % 60).padStart(2, '0')}.000Z`;
    if (i === 120 || i === 121) lines.push(`${t} Error: expected 3 to equal 4 (test/unit/widget.test.js:${40 + i})`);
    else if (i === 150) lines.push('2026-11-14T10:02:30.000Z npm ERR! code ELIFECYCLE');
    else lines.push(`${t} step output line ${i}`);
  }
  return `${lines.join('\n')}\n`;
}

const HANDLERS = {
  'listRuns.js': `// STAND-IN (measurement only): one failed run, canned; no remote.
module.exports = async () => ({output: {runs: [{runId: '1234567890', conclusion: 'failure', commit: '${SHA}', branch: 'main', createdAt: '2026-11-14T10:00:00Z', workflow: 'CI', url: 'https://github.example/acme/widgets/actions/runs/1234567890'}]}});
`,
  'failedJobs.js': `// STAND-IN (measurement only): one failed job, canned; no remote.
module.exports = async () => ({output: {jobs: [{jobId: '9876543210', name: 'test (24)', conclusion: 'failure', steps: [{name: 'Install', conclusion: 'success'}, {name: 'Test', conclusion: 'failure'}]}]}});
`,
  'jobLog.js': `// STAND-IN (measurement only): a 200-line log, canned; no remote.
const text = ${JSON.stringify(log())};
module.exports = async () => ({output: {text, lines: 200, bytes: Buffer.byteLength(text, 'utf8'), expired: false, truncated: false}});
`,
  'runCommits.js': `// STAND-IN (measurement only): the run's commit, canned; no remote.
module.exports = async () => ({output: {commit: '${SHA}', authorLogin: 'octo-dev'}});
`
};

function main([from, out]) {
  if (from == null || out == null) throw new Error('usage: make-standin.js <installed pack\'s node_modules/@countinghouse> <out dir>');
  const dest = path.join(out, 'node_modules', '@countinghouse');
  fs.rmSync(path.join(out, 'node_modules'), {recursive: true, force: true});
  fs.mkdirSync(dest, {recursive: true});
  for (const name of PACKAGES) {
    if (!fs.existsSync(path.join(from, name, 'package.json'))) throw new Error(`${name} is not installed in ${from}`);
    fs.cpSync(path.join(from, name), path.join(dest, name), {recursive: true});
  }
  const access = path.join(dest, 'ch-access-github');
  const pkg = JSON.parse(fs.readFileSync(path.join(access, 'package.json'), 'utf8'));
  delete pkg.countinghouse.remotes;
  pkg.description = 'A STAND-IN for measurement only (not the real ch-access-github): the same name, api.json and schema.json, its four actions answering canned results with no remote.';
  fs.writeFileSync(path.join(access, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [file, text] of Object.entries(HANDLERS)) fs.writeFileSync(path.join(access, 'handlers', 'githubService', file), text);
  process.stdout.write(`stand-in pack in ${dest}; scenario at ${path.join(dest, 'ch-pack-ci-failure-triage')}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
module.exports = {main};

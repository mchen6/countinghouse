'use strict';
// This server's own id (B-j1): 16 random hex characters, generated at its
// first start and kept in <moduleDataPath>/.server-id (<storePath>/ in the
// single-identity profile: where the identity secret is kept), with the
// identity secret's checks (lib/private-file.js: mode 0600 or this user's
// ACL, never through a link, written whole, the --hardened parent's check on
// Windows). Never derived from key material: rotating the identity secret
// leaves it as it is. Two runtimes on one data directory are one server, and
// share it; two on separate directories have their own.
//
// It names what this server keeps in a Redis it may share with others: its
// BullMQ job queue's prefix and its job history keys
// (lib/job-control-common.js jobQueuePrefix, jobInfoKeyFor).
const crypto = require('crypto');
const path   = require('path');
const privateFile = require('./private-file');

const SERVER_ID_FILE = '.server-id';
const ID_FORM = /^[0-9a-f]{16}$/;

function refuse(message) {
  return Object.assign(new Error(message), {code: 'SERVER_ID_INVALID'});
}
const SPEC = {what: 'the server id', form: ID_FORM, formText: '16 hex characters', variable: 'COUNTINGHOUSE_SERVER_ID_ACL_CHECKED', refuse};

let serverId = null;

const fileFor = (options) => path.join(privateFile.ownDir(options), SERVER_ID_FILE);

// The id kept for these options, or null when there is none yet: the one
// reader, the runtime's and a test's (test/helpers/job-queue.js).
function read(options) {
  return privateFile.readChecked(fileFor(options), SPEC);
}

// Loads the id, or makes it on a first start. Throws (startup refuses, exit
// 2) on a file in the wrong form, reachable by others or through a link.
function initSync(options) {
  const file = fileFor(options);
  const found = read(options);
  if (found != null) {
    serverId = found;
    return;
  }
  if (process.platform === 'win32' && process.permission != null) throw privateFile.refuseAbsentUnderHardened(file, SPEC);
  serverId = create(options);
}

function create(options) {
  const dir = privateFile.ownDir(options);
  const made = crypto.randomBytes(8).toString('hex');
  // another start on this directory may have made it first: then its id is
  // this server's too
  if (privateFile.createPrivate(dir, fileFor(options), made, SPEC, privateFile.flagOf(dir, options))) return made;
  return read(options);
}

// --hardened on Windows: made, if there is none, and checked by the parent
// before the relaunch, as the identity secret is (lib/identity.js).
function prepareForHardened(options, hooks = {}) {
  if (process.platform !== 'win32') return;
  privateFile.prepareForHardened(fileFor(options), SPEC, {
    create: () => { create(options); return true; },
    check: () => { read(options); }
  }, hooks);
}

function ready() {
  return serverId != null;
}

function get() {
  if (serverId == null) throw new Error('server-id: not initialized');
  return serverId;
}

// a test's: back to no id (an in-process test that ran initSync)
function reset() {
  serverId = null;
}

module.exports = {initSync, prepareForHardened, read, ready, get, reset, SERVER_ID_FILE};

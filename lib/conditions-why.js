'use strict';
// Why a session's client said "conditions: no" (contract 2's conditionsWhy:
// docs/superpowers/specs/shared-runtime-wire/vectors.json). ch-local's
// conditions child adds it to a status-ok client line whose conditions is
// "no": exactly {reason} or {reason, at}. reason is one of REASONS; at is
// "~/" and a path under the user's home, at most 200 characters, with no
// ".." segment and no hidden character. A path outside the home is never
// sent, and the user's name never is (the home is "~").
//
// It reaches the agent's context, and so the model's provider, in the
// settings tool's refusal for a latched session. So it is checked here
// again, whatever the shim and the daemon checked: a why the rule refuses is
// no why, and is never shown.
//
//   check(value) -> a copy of {reason, at?}, or null
//   said(why)    -> the refusal's sentence for it (null: "could not be
//                   confirmed")
const V = require('../docs/superpowers/specs/shared-runtime-wire/vectors.json').conditionsWhy;

const REASONS = Object.freeze(V.reasons.slice());
const HIDDEN = new RegExp(`[${V.hiddenClass}]`, 'u');
const MAX_AT = 200;

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);

function check(value) {
  if (!isObject(value) || !Object.keys(value).every((k) => k === 'reason' || k === 'at')) return null;
  if (typeof(value.reason) !== 'string' || !REASONS.includes(value.reason)) return null;
  if (value.at === undefined) return {reason: value.reason};
  const at = value.at;
  if (typeof(at) !== 'string' || !at.startsWith('~/') || Array.from(at).length > MAX_AT || HIDDEN.test(at) || at.split('/').includes('..')) return null;
  return {reason: value.reason, at: at};
}

function said(why) {
  const w = check(why);
  if (w == null) return 'this client could not be confirmed';
  return `this client's configuration could answer forms by itself (${w.reason}${w.at !== undefined ? `: ${w.at}` : ''})`;
}

module.exports = {check, said, REASONS};

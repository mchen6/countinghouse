'use strict';
// Why a session's client said "conditions: no" (contract 2's conditionsWhy).
// ch-local's conditions child adds it to a status-ok client line whose
// conditions is "no": exactly {reason} or {reason, at}. reason is one of
// REASONS; at is "~/" and a path under the user's home, at most 200
// characters, with no hidden character. A path outside the home is never
// sent, and the user's name never is (the home is "~").
//
// It reaches the agent's context, and so the model's provider, in the
// settings tool's refusal for a latched session. So it is checked here
// again, whatever the shim and the daemon checked, and a little more
// strictly than the vectors: no "..", no empty segment, no backslash (on
// Windows one is a separator, so "~/..\\.." would leave the home). A why the
// rule refuses is no why, and is never shown.
//
// The rule is lib/conditions-why.json: the published package has no docs/,
// and test/sessions/23 holds the file equal to the shared vectors.
//
//   check(value) -> a copy of {reason, at?}, or null
//   said(why)    -> {en, zh}: the refusal's sentence (a field the catalogue
//                   reads per locale); null: "could not be confirmed"
const RULE = require('./conditions-why.json');

const REASONS = Object.freeze(RULE.reasons.slice());
const HIDDEN = new RegExp(`[${RULE.hiddenClass}]`, 'u');
const MAX_AT = RULE.maxAt;

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);

function check(value) {
  if (!isObject(value) || !Object.keys(value).every((k) => k === 'reason' || k === 'at')) return null;
  if (typeof(value.reason) !== 'string' || !REASONS.includes(value.reason)) return null;
  if (value.at === undefined) return {reason: value.reason};
  const at = value.at;
  if (typeof(at) !== 'string' || !at.startsWith('~/') || Array.from(at).length > MAX_AT || HIDDEN.test(at) || at.includes('\\')) return null;
  const segments = at.slice(2).split('/');
  if (segments.some((s) => s === '' || s === '..')) return null;
  return {reason: value.reason, at: at};
}

// The reason is a token of the closed set, said as it is (in every language).
function said(why) {
  const w = check(why);
  if (w == null) return {en: 'this client could not be confirmed', zh: '无法确认此客户端'};
  const what = `${w.reason}${w.at !== undefined ? `: ${w.at}` : ''}`;
  const whatZh = `${w.reason}${w.at !== undefined ? `：${w.at}` : ''}`;
  return {en: `this client's configuration could answer forms by itself (${what})`, zh: `此客户端的配置可能代你作答（${whatZh}）`};
}

module.exports = {check, said, REASONS};

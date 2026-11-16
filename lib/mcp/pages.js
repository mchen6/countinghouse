'use strict';
// Pagination for MCP's list methods (MCP completeness M1, spec section 5):
// tools/list now, and prompts/list, resources/list and
// resources/templates/list as they list anything.
//
// A cursor is opaque to the client: base64url of {v: 1, k: kind, a: anchor},
// where the anchor is the last item's key on the page before (a tool's name,
// a resource's URI). It is a keyset, not an offset: packs change in place,
// and an offset would skip or repeat items silently, while a keyset resumes
// after an item that is still there.
//
// It is not signed. The server derives and filters the caller's own list
// again on every page and uses the cursor only as a position in it, so a
// forged cursor can name only an item already in the caller's own list.
// Anything that names no position -- malformed, oversized, another kind's,
// or an anchor no longer listed (its module unloaded between pages) -- is
// null, and the caller answers every null with the same -32602, so the
// answer tells nothing about other callers' lists.
const MAX_CURSOR_BYTES = 512;
// a tool's name is <device>_<service>_<action>: up to 64 + 128 + 64
// characters and a _<n> suffix, so every name the server lists is taken back
// (the cursor stays within 512 bytes)
const MAX_ANCHOR_CHARS = 320;
const VERSION = 1;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function encodeCursor(kind, anchor) {
  return Buffer.from(JSON.stringify({v: VERSION, k: kind, a: anchor})).toString('base64url');
}

// cursor -> its anchor, or null for anything that is no cursor of `kind`
function decodeCursor(kind, cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_BYTES || !BASE64URL.test(cursor)) return null;
  let v;
  try { v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v).sort();
  if (keys.length !== 3 || keys[0] !== 'a' || keys[1] !== 'k' || keys[2] !== 'v') return null;
  if (v.v !== VERSION || v.k !== kind) return null;
  if (typeof v.a !== 'string' || v.a.length === 0 || v.a.length > MAX_ANCHOR_CHARS) return null;
  return v.a;
}

// keys: the caller's whole list, in order. anchor: undefined for the first
// page. -> {from, to, next}: the page is keys.slice(from, to), and next is
// the anchor of the page after it (null on the last). null when the anchor
// is not in the list.
function page(keys, anchor, size) {
  let from = 0;
  if (anchor !== undefined) {
    const at = keys.indexOf(anchor);
    if (at === -1) return null;
    from = at + 1;
  }
  const to = Math.min(keys.length, from + size);
  return {from, to, next: to < keys.length ? keys[to - 1] : null};
}

// A page's bytes (M2: inlined icons make a tool up to ~87 KB): a page ends
// before the item that would take its JSON past MAX_PAGE_BYTES, with one item
// at least. Well inside every transport's bound (a shared runtime's frame to
// the shim is 513 MiB). -> how many of `items`, in order, the page keeps.
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
// what a page's answer holds beside its items: the JSON-RPC envelope, the
// caching hints and a nextCursor of at most MAX_CURSOR_BYTES
const ENVELOPE_BYTES = 1024;
function fitting(items, max = MAX_PAGE_BYTES - ENVELOPE_BYTES) {
  let bytes = 2;   // [ and ]
  for (let i = 0; i < items.length; i++) {
    bytes += Buffer.byteLength(JSON.stringify(items[i])) + (i > 0 ? 1 : 0);
    if (bytes > max) return Math.max(1, i);
  }
  return items.length;
}

module.exports = {encodeCursor, decodeCursor, page, fitting, MAX_CURSOR_BYTES, MAX_ANCHOR_CHARS, MAX_PAGE_BYTES};

// Prints the sorted list of every HTTP path lib/route-manager.js's
// installNormalRoutes mounts, one JSON array on stdout. Run as its own
// process by test/module-loading/11-route-inventory.js -- requiring
// route-manager in the mocha process leaves open handles, and the
// module-loading glob runs without --exit, so an in-process version would
// stall the suite.
//
// installNormalRoutes is called against a stub rather than a real
// RouteManager: the route modules only build routers at mount time and do not
// touch mm/cdifInterface until a request arrives, so stubs are enough to get a
// faithful mount table without booting a server or binding a port -- the
// stub's prototype is RouteManager.prototype, but the RouteManager
// constructor itself never runs.
//
// Coverage this gives: every mount made by installNormalRoutes, which today
// is all of them. It would NOT see a mount added directly in the
// RouteManager constructor, or one framework.js adds to routeManager.app
// after construction -- neither exists today, but either would need its own
// guard, not an extension of this one.
const events  = require('events');
const express = require('express');
const path    = require('path');

const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'lib', 'cli-options')).setOptions({});
const RouteManager = require(path.join(ROOT, 'lib', 'route-manager'));

const fake = Object.create(RouteManager.prototype);
fake.app                 = express();
fake.deviceControlRouter = express.Router();
fake.moduleManager       = new events.EventEmitter();
fake.cdifInterface       = new events.EventEmitter();
fake.cdifInterface.deviceManager = new events.EventEmitter();

RouteManager.prototype.installNormalRoutes.call(fake);

// express 4 stores each mount as a regexp; decode it back to a readable path.
// layer.keys carries the :param names in order, so the capture groups can be
// put back as :deviceID rather than left as (?:/([^/]+?)).
function seg(layer) {
  if (layer.regexp == null || layer.regexp.fast_slash) return '';
  let s = layer.regexp.source;
  s = s.replace(/^\^/, '');
  s = s.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');   // use()-style tail
  s = s.replace(/\\\/\?\$$/, '');                 // route()-style tail
  s = s.replace(/\\\//g, '/');
  let i = 0;
  return s.replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g,
                   () => `/:${((layer.keys && layer.keys[i++]) || {name: 'param'}).name}`);
}

function walk(stack, prefix) {
  const out = [];
  for (const layer of stack) {
    const here = prefix + seg(layer);
    if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      out.push(...walk(layer.handle.stack, here));
    } else if (here !== '') {
      out.push(here);
    }
  }
  return out;
}

// app.router (no underscore) is a throwing deprecation getter in express 4, so
// this must use _router -- and must fail loudly if a future express drops it,
// rather than reporting an empty inventory that would pass forever.
if (fake.app._router == null || !Array.isArray(fake.app._router.stack)) {
  process.stderr.write('cannot read app._router.stack -- express internals moved; ' +
                       'update test/fixtures/route-inventory.js\n');
  process.exit(2);
}

const inventory = [...new Set(walk(fake.app._router.stack, ''))].sort();
process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
process.exit(0);

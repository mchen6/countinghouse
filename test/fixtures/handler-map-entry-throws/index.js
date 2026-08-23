// Deliberately-broken fixture for lib/module-validator.js's loadModuleEntry
// check: package.json's main (defaulting to index.js) exists on disk and
// throws when required, even though the module also has a valid handlers/
// tree that resolveHandlerMap can assemble from independently of this file.
// Before the loadModuleEntry check existed, a module shaped exactly like
// this one validated as {ok: true, problems: []} -- clean -- and would have
// crashed the real server on load. See
// test/module-loading/01-load-failure-diagnostics.js for the same defect
// class this codebase was already burned by once.
throw new Error('boom');

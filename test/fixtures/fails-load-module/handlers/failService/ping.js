// Throws when the module's worker loads it: a --loadModule module that fails
// (test/stdio/04).
throw new Error('fails-load-module: this handler throws when it is loaded');

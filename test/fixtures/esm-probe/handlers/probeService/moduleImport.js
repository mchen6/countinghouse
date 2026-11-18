// moduleImport.js -- an ES-module handler that imports the module built-in
// by both of its names (#406's high review: under enforce the lockdown
// serves a reduced one, which an import must still reach on every Node line)
import {createRequire} from 'module';
import * as prefixed from 'node:module';
import byDefault from 'node:module';
// a name the reduced one lacks still links (undefined there), one the
// lockdown made non-enumerable too
import {findPackageJSON, enableCompileCache} from 'node:module';

// reduced: the lockdown's (no _load), or the real one
export default async () => ({output: {named: typeof createRequire, prefixed: typeof prefixed.createRequire, byDefault: typeof byDefault.createRequire,
  reduced: typeof byDefault._load === 'undefined', linked: typeof findPackageJSON !== 'symbol' && typeof enableCompileCache !== 'symbol'}});

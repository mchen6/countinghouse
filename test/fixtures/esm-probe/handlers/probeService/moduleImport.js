// moduleImport.js -- an ES-module handler that imports the module built-in
// by both of its names (#406's high review: under enforce the lockdown
// serves a reduced one, which an import must still reach on every Node line)
import {createRequire} from 'module';
import * as prefixed from 'node:module';
import byDefault from 'node:module';

export default async () => ({output: {named: typeof createRequire, prefixed: typeof prefixed.createRequire, byDefault: typeof byDefault.createRequire}});

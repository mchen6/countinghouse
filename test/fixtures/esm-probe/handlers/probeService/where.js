// where.js -- an ES-module handler: its URL, its directory, a relative import and a dependency.
import helper from '../../lib/helper.js';
import dep from 'plain-dep';
import depFile from 'plain-dep/where.js';

export default async () => ({output: {url: import.meta.url, dirname: import.meta.dirname, helper: helper, dep: dep, depFile: depFile}});

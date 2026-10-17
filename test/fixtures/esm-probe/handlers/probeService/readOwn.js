// readOwn.js -- named imports from node:fs in an ES module.
import {readFileSync, realpathSync} from 'node:fs';

export default async () => ({output: {name: JSON.parse(readFileSync('/app/package.json', 'utf8')).name, real: realpathSync.native('/data')}});

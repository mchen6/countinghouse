// Run through a linked spelling of the install (test/fs-broker/27): a
// module's spawn, as the module manager makes it (lib/fs-broker
// createForWorker), with the declared roots given; prints what was refused.
//   node --preserve-symlinks --preserve-symlinks-main links-spawn.js <module dir> <data dir> <declared JSON>
const path = require('path');
const {createForWorker} = require(path.join(__dirname, '..', '..', '..', 'lib', 'fs-broker'));

(async () => {
  const [modulePath, moduleDataPath, declared] = process.argv.slice(2);
  const reported = [];
  const fsb = await createForWorker({name: 'm', mode: 'audit', modulePath: modulePath, declared: JSON.parse(declared),
    options: {moduleDataPath: moduleDataPath, modulePath: path.dirname(modulePath), authConfigPath: path.join(path.dirname(modulePath), 'auth.json'),
      deviceConfigPath: path.join(path.dirname(modulePath), 'devices')}, report: (kind, text) => { if (kind === 'refused') reported.push(text); }});
  try {
    console.log(JSON.stringify({refused: fsb.namespace.refused, reported: reported,
      declaredRoots: fsb.namespace.roots.filter((r) => r.name === 'declared').map((r) => r.host)}));
  } finally {
    await fsb.bridge.close();
  }
})();

// THROWAWAY (C-win-baseline diag, never merged): on Windows, an exclusive
// create through a dangling link -- does it make the link's target, inside
// or outside the namespace? Each op on its own link; reports what exists.
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {mkdtemp} = require('../helpers/test-tmp');
describe('DIAG excl through a dangling link', () => {
  it('reports', async () => {
    const base = mkdtemp('diag-excl-');
    const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), outside: path.join(base, 'outside')};
    Object.values(dirs).forEach((d) => fs.mkdirSync(d));
    fs.writeFileSync(path.join(dirs.data, 'plain'), 'p');
    const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
    await ns.prepare();
    const out = {};
    for (const mode of ['enforce', 'audit']) {
      const broker = new FsBroker({name: 'm', mode, namespace: ns, cwd: '/', report: () => {}});
      const ops = {
        openWx: (l) => broker.handle('open', [l, 'wx']),
        openWxInside: (l) => broker.handle('open', [l, 'wx']),
        copyExcl: (l) => broker.handle('copyFile', ['/data/plain', l, fs.constants.COPYFILE_EXCL]),
        writeFileWx: (l) => broker.handle('writeFile', [l, 'x', {flag: 'wx'}]),
        openW: (l) => broker.handle('open', [l, 'w'])
      };
      for (const [k, op] of Object.entries(ops)) {
        const inside = k === 'openWxInside';
        const name = `${mode}-${k}`;
        const target = inside ? path.join(dirs.data, `t-${name}`) : path.join(dirs.outside, `t-${name}`);
        fs.symlinkSync(target, path.join(dirs.data, `l-${name}`));
        let code;
        try { const r = await op(`/data/l-${name}`); code = `ok ${typeof r}`; if (typeof r === 'number') { try { await broker.handle('close', [r]); } catch (e) { /* */ } } } catch (e) { code = e.code; }
        out[name] = {code, targetMade: fs.existsSync(target)};
      }
      await broker.closeAll();
    }
    console.log(`DIAG ${  JSON.stringify(out)}`);
    fs.rmSync(base, {recursive: true, force: true});
  });
});

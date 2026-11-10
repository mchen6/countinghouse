// Node 26's fs.openAsBlobSync, from inside a module worker: brokered like
// fs.openAsBlob, so it reads only what the module may read.
module.exports = async (fs) => {
  const out = {present: typeof(fs.openAsBlobSync) === 'function'};
  if (!out.present) return out;
  const blob = fs.openAsBlobSync('/data/f.txt', {type: 'text/plain'});
  out.inside = {text: await blob.text(), type: blob.type, isBlob: blob instanceof Blob};
  try { fs.openAsBlobSync('/etc/hostname'); out.outside = 'read'; } catch (e) { out.outside = e.code; }
  return out;
};

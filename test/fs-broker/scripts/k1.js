// Reads a file by host path, by name and through a descriptor.
module.exports = async (fs, root, ctx) => {
  const fd = fs.openSync(ctx.extra.file, 'r');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  return {content: fs.readFileSync(ctx.extra.file, 'utf8'), viaFd: b.toString()};
};

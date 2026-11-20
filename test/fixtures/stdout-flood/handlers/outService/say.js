// One line to each stream, a terminal escape in each, and one long line.
module.exports = async () => {
  process.stdout.write('stdout-flood says \x1b[31mred\x1b[0m on stdout\x07\n');
  process.stderr.write('stdout-flood says \x1b]0;title\x07 on stderr\n');
  process.stdout.write(`${'L'.repeat(20000)}\n`);
  return {output: {ok: true}};
};

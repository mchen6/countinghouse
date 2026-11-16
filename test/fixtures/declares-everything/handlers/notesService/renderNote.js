// Declares binary output fields: a PNG under properties, JPEGs as an array's
// items. The cover is the module's own icon. A page is a JPEG's first and
// last markers and nothing between them: bytes of the declared type, not a
// picture.
const fs = require('fs');
const path = require('path');
const notes = require('../../store');

const PAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

module.exports = async (input) => {
  if (!notes.has(input.id)) throw new Error(`no note ${JSON.stringify(input.id)}`);
  const cover = fs.readFileSync(path.join(__dirname, '..', '..', 'icons', 'note.png')).toString('base64');
  return {output: {cover: cover, pages: [PAGE]}};
};

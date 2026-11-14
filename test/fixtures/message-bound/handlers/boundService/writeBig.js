// A file larger than one bridge call: the patch splits it into chunks.
const fs = require('fs');
module.exports = async () => {
  fs.writeFileSync('/data/big', Buffer.alloc(17 * 1024 * 1024, 1));
  return {output: {size: fs.statSync('/data/big').size}};
};

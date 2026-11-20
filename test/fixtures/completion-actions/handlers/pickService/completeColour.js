'use strict';
// 'many' answers 150 values (the runtime keeps 100); 'long' one value of 256
// characters and one of 257 (the runtime keeps at most 256); otherwise three
// colours
module.exports = async (input) => {
  if (input.value === 'many') return {output: {values: Array.from({length: 150}, (_, i) => `many-${String(i).padStart(3, '0')}`)}};
  if (input.value === 'long') return {output: {values: [`long${'a'.repeat(252)}`, `long${'b'.repeat(253)}`]}};
  return {output: {values: ['crimson', 'coral', 'cyan']}};
};

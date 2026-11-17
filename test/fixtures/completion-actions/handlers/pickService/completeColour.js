'use strict';
// 'many' answers 150 values (the runtime keeps 100); otherwise three colours
module.exports = async (input) => {
  if (input.value === 'many') return {output: {values: Array.from({length: 150}, (_, i) => `many-${String(i).padStart(3, '0')}`)}};
  return {output: {values: ['crimson', 'coral', 'cyan']}};
};

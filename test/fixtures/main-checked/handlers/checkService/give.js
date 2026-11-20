// An output the action's schema refuses, in each way it can.
module.exports = async (input) => {
  if (input.kind === 'badType') return {output: {v: 1}};
  if (input.kind === 'extraKey') return {output: {v: 'a'}, extra: true};
  if (input.kind === 'noOutput') return {};
  return {output: {v: 'a'}};
};

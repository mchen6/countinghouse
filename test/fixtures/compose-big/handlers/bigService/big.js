// An answer its own output schema refuses: the main thread's validator refuses
// it after the hop was sent (OUTPUT_DATA_VALIDATION_FAIL), the runtime's own
// refusal of the caller's call (composition 25).
module.exports = async () => ({output: {n: 'not a number'}});

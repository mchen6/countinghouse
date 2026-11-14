// Lean worker step 3 (test/sandbox/48; the high review of #177): CHUtil.invokeAction goes
// through the lockdown's host check, as CHUtil.request does.
const outcome = (e) => ({outcome: 'error', code: (e != null && e.code != null) ? String(e.code) : null, message: String(e && e.message).slice(0, 300)});
module.exports = (input) => new Promise((resolve) => {
  try {
    CHUtil.invokeAction('a-key', input.url, 'urn:x:serviceID:s', 'a', {input: {}}, (err) => resolve({output: (err != null) ? outcome(err) : {outcome: 'sent'}}));
  } catch (e) { resolve({output: outcome(e)}); }
});

// fetchGet.js -- fetch from https://127.0.0.1:port/: {code: 'ok', body}, or
// the error code (the cause's, when fetch wraps one); gives up after 5 s.
module.exports = async (input) => {
  try {
    const res = await fetch(`https://127.0.0.1:${input.port}/`, {signal: AbortSignal.timeout(5000)});
    return {output: {code: 'ok', status: res.status, body: await res.text()}};
  } catch (e) {
    const cause = (e != null && e.cause != null) ? e.cause : e;
    return {output: {code: String((cause && cause.code) || (e && e.code) || (cause && cause.message) || e.message)}};
  }
};

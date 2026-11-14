// Where --moduleSandbox enforce holds. On win32 a module's identity (its files
// as /app/..., lib/fs-broker/identity.js) is not designed for Windows file
// URLs yet (#195), so enforce could not keep a module to its own files there:
// it refuses to start instead of half-working, and audit is the Windows mode
// for now. framework.js exits 2 with this message.
const ISSUE = 'https://github.com/mchen6/countinghouse/issues/195';

// mode, platform -> the refusal's message, or null. env.CH_ENFORCE_WIN32_PREVIEW
// = 1 lets #195's Windows CI rounds start enforce while its design is built:
// a test switch, removed with this refusal when enforce holds there.
function platformRefusal(mode, platform, env = {}) {
  if (mode !== 'enforce' || platform !== 'win32') return null;
  if (env.CH_ENFORCE_WIN32_PREVIEW === '1') return null;
  return `--moduleSandbox enforce is not available on Windows yet: a module's identity is not designed for Windows file URLs (${ISSUE}). Use --moduleSandbox audit, the Windows mode for now.`;
}

module.exports = {platformRefusal, ISSUE};

// Loaded by every mocha run (.mocharc.json). Test servers inherit the
// variable, and framework.js then refuses to start without an explicit
// thread flag, so no test can silently change mode when a default changes.
process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG = '1';

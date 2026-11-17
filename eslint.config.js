// Style gate for the 6.0.0 modernization (docs/v6-module-api-and-es6-design.md
// section 2). Deliberately narrow: exactly the five rules that section names,
// not eslint:recommended. The point is to hold the ES6 conversion in place, not
// to open a second front of unrelated lint findings across 17k lines of code
// that predate any linter.
//
// no-undef in particular is left off on purpose -- this is CommonJS with a few
// intentional implicit globals in the older tests, and turning it on would
// require a globals map that says nothing about the conversion.
//
// Scope matches section 2's: lib/, bin/, pre-installed-packages/, test/, perf/.
// spec/ is excluded because its JS is CDIF 3.x-era historical material kept
// deliberately unconverted (see spec/README.md), and adaptive-test/ because it
// is a benchmark asset, not part of this refactor.
module.exports = [
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'spec/**',
      'adaptive-test/**',
      'example/**',

      // Deliberately ES5, and must stay that way: it is the input to
      // test/module-loading/09-migrator.js, which exists because the migrator
      // originally only understood the ES6 spelling and so refused every real
      // 5.x module. Linting this fixture into ES6 would delete the thing it
      // is testing.
      'test/fixtures/legacy-5x-module/**'
    ]
  },
  {
    files: [
      'lib/**/*.js',
      'bin/**/*.js',
      'pre-installed-packages/**/*.js',
      'test/**/*.js',
      'perf/**/*.js',

      // Added after section 2's original scope: examples/ did not exist then,
      // and a directory the README points readers at as the worked example of
      // how to write a module has to be held to the style it demonstrates.
      // Note this is examples/ (the demo modules), not example/ (pre-rebrand
      // deployment scraps), which stays ignored above.
      'examples/**/*.js'
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs'
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'no-prototype-builtins': 'error'
    }
  },

  // An ES-module fixture: its package.json says "type": "module", which is
  // what test/fs-broker/12-identity.js tests.
  {
    files: ['test/fixtures/esm-probe/**/*.js', 'test/fixtures/win-probe/lib/esm-pkg/*.js'],
    ignores: ['test/fixtures/esm-probe/node_modules/**'],
    languageOptions: {sourceType: 'module'}
  },

  // #194: no runtime function is ever handed out by fn.caller or
  // arguments.callee.caller, which a sloppy-mode module function could read
  // while the runtime calls it. So every runtime file is strict, and a new
  // one without the directive fails here.
  {
    files: ['lib/**/*.js', 'bin/**/*.js', 'framework.js'],
    rules: {strict: ['error', 'global']}
  },

  // The runtime's own files have no implicit globals, so a free name there is
  // a bug, never a convention: no-undef is on for lib/ (not for the tests,
  // whose few intentional implicit globals are the reason it is off above).
  // #327's merge left `name` unbound in runModuleTarget (lib/mcp/gateway.js):
  // lint never checked free names, so the ReferenceError reached master, where
  // it was swallowed into ASK_UNAVAILABLE for every 2026-07-28 ask (#355). Node's globals are
  // listed here, the ones lib/ uses and a few it plausibly will, rather than
  // read from the transitive `globals` package (no new dependency). A file
  // that truly means a name it doesn't define says so with /* global */
  // (lib/couchdb-adapter/init-db.js: CouchDB's emit).
  {
    files: ['lib/**/*.js'],
    languageOptions: {
      globals: Object.fromEntries([
        'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global', 'globalThis', 'console',
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask',
        'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'performance',
        'AbortController', 'AbortSignal', 'fetch', 'Headers', 'Request', 'Response', 'Blob'
      ].map((g) => [g, 'readonly']))
    },
    rules: {'no-undef': 'error'}
  },

  // framework.js is the entry point and returns at top level when --hardened
  // hands startup to the re-launched child (lib/hardened-launch.js).
  {
    files: ['framework.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      parserOptions: {ecmaFeatures: {globalReturn: true}}
    }
  }
];

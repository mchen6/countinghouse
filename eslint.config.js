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
      'docker/**'
    ]
  },
  {
    files: [
      'lib/**/*.js',
      'bin/**/*.js',
      'pre-installed-packages/**/*.js',
      'test/**/*.js',
      'perf/**/*.js'
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
  }
];

import unjs from 'eslint-config-unjs'

// https://github.com/unjs/eslint-config
export default unjs(
  {
    rules: {
      'no-undef': 0,
      'unicorn/consistent-destructuring': 0,
      'unicorn/no-await-expression-member': 0,
      '@typescript-eslint/no-empty-object-type': 0,
    },
  },
  {
    files: ['test/**/*.types.test.ts'],
    rules: {
      // These branches exercise compile-time errors without executing bad calls.
      'no-constant-condition': 'off',
    },
  },
  {
    files: ['test/**/*.test.ts'],
    rules: {
      // Fixtures intentionally test the public PromiseLike contract.
      'unicorn/no-thenable': 'off',
    },
  },
)

module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    browser: true
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  ignorePatterns: [
    'dist',
    'build',
    'coverage',
    'node_modules',
    '.turbo',
    'apps/android-tv/**',
    '*.config.js',
    '*.config.cjs'
  ],
  overrides: [
    {
      files: ['apps/tizen/src/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: ['apps/webos/*', '../webos/*', '../../webos/*', '../../../webos/*']
          }
        ]
      }
    },
    {
      files: ['apps/webos/src/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: ['apps/tizen/*', '../tizen/*', '../../tizen/*', '../../../tizen/*']
          }
        ]
      }
    }
  ]
};

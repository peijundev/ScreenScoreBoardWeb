import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'public/v2/**', 'dist/**', 'data/**', 'Ress/**'],
  },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'electron/**/*.js', 'bin/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-empty': 'off',
      'no-constant-condition': 'off',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'off',
      'no-fallthrough': 'off',
      'no-useless-assignment': 'off',
      'no-irregular-whitespace': 'off',
      'preserve-caught-error': 'off',
    },
  },
];

import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'public/assets',
      'test-results',
      'playwright-report',
      'coverage',
      'bench-results',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The simulation cores stay pure TypeScript: no three.js, React, DOM or engine imports (plan principle 1).
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*', 'react', 'react-dom', '**/engine/**', '**/app/**', '**/procgen/**'],
              message: 'src/sim must stay pure TypeScript (plan principle 1).',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'document', 'window'],
    },
  },
  {
    // TSL node graphs are loosely typed in @types/three.
    files: [
      'src/engine/**/*.ts',
      'src/procgen/**/*.ts',
      'src/photo/**/*.ts',
      'src/workshop/**/*.ts',
      'tests/e2e/**/*.ts',
      'tools/**/*.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);

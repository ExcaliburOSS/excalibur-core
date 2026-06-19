import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'examples/demo-repo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The whole repo runs on Node (CLI + packages + scripts), so Node globals
    // (process, console, Buffer, timers, URL, …) are always in scope.
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);

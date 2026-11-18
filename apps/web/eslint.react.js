// ESLint rules for the React app, spread into the root eslint.config.js.
// Kept here so the plugins resolve from apps/web's own dependencies.
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const files = ['apps/web/**/*.{ts,tsx}'];

export default [
  {
    files,
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['apps/web/vite.config.ts', 'apps/web/public/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];

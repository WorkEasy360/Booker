// ESLint configuration for the web app (flat config, ESLint 10).
// It restores the setup of the Vite React + TypeScript template this project started from, which the existing
// `eslint-disable-line react-hooks/exhaustive-deps` comments rely on: JS and TypeScript recommended rules, the two
// classic React Hooks rules, and React Refresh. The API in server/ is a separate package with its own toolchain.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // Build output, the API package, test artefacts, and plain JS/config files (the lint script has always covered
  // TypeScript sources only).
  globalIgnores(['dist', 'server', '.acceptance', '**/*.{js,mjs,cjs}']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Context hooks live next to their providers. This only affects development hot reload (the file reloads
      // fully), so these exports are allowed by name.
      'react-refresh/only-export-components': ['warn', {
        allowConstantExport: true,
        allowExportNames: ['useToast', 'useAI', 'useAuth', 'useLanguage'],
      }],
      // `const { omitted: _x, ...rest } = obj` is how a property is left out of a copy.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // Node-side files: unit tests run with `node --test`, and the Vite config runs in Node.
    files: ['tests/**/*.ts', 'vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
]);

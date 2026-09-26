//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'
import tseslint from 'typescript-eslint'

export default [
  { ignores: ['.output/**', 'convex/_generated/**', 'src/routeTree.gen.ts'] },
  ...tanstackConfig,
  {
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'import/no-cycle': 'off',
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      // Convex query results can be absent at runtime even when generated
      // references infer a narrower type across the app's async boundaries.
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      'pnpm/json-enforce-catalog': 'off',
    },
  },
  {
    ignores: ['eslint.config.js', 'prettier.config.js'],
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      'no-var': 'off',
      '@typescript-eslint/method-signature-style': 'off',
    },
  },
]

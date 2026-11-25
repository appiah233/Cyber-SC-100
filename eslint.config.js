import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', '.private/**'] },
  { files: ['**/*.ts', '**/*.tsx'], extends: [js.configs.recommended, ...tseslint.configs.recommended] },
  {
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
)

// eslint-config-next v16 ships native flat config arrays, so no FlatCompat shim.
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'data/**', 'src/db/migrations/**'] },

  ...coreWebVitals,
  ...typescript,

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      // Seed and migration scripts report progress on stdout by design.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Command-line tools: reporting progress on stdout is their whole purpose.
    files: ['src/db/**/*.ts', 'scripts/**/*.mjs', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];

export default config;

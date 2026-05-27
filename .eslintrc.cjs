module.exports = {
  extends: ['eslint-config-salesforce-typescript', 'eslint-config-salesforce-license', 'plugin:sf-plugin/library'],
  ignorePatterns: ['test/nuts/ebikes-lwc', 'test/nuts/repros/reactinternalapp'],
  plugins: ['local-rules', '@effect', 'functional'],
  overrides: [
    {
      // Effect-using files. Mirrors the regime in salesforcedx-vscode/eslint.config.mjs (lines 583-645).
      files: ['**/populateTypesAndNames.ts', '**/populateTypesAndNamesPerf.nut.ts'],
      rules: {
        '@effect/no-import-from-barrel-package': ['error', { packageNames: ['effect'] }],
        'functional/no-loop-statements': 'error',
        'functional/no-let': 'error',
        'functional/no-throw-statements': 'error',
        'functional/no-try-statements': 'error',
        'functional/prefer-property-signatures': 'error',
        'local-rules/no-explicit-effect-return-type': 'error',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/no-floating-promises': 'error',
      },
    },
  ],
};

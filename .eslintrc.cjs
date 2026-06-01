module.exports = {
  extends: ['eslint-config-salesforce-typescript', 'eslint-config-salesforce-license', 'plugin:sf-plugin/library'],
  ignorePatterns: ['test/nuts/ebikes-lwc', 'test/nuts/repros/reactinternalapp'],
  plugins: ['local-rules', '@effect', 'functional'],
  rules: {
    // Catch import cycles project-wide. Pattern from salesforcedx-vscode
    // (vscode-3/eslint.config.mjs:366).
    'import/no-cycle': ['error', { maxDepth: 10, ignoreExternal: true }],
  },
  overrides: [
    {
      // Effect-using tests: relax the no-unsafe-* rules that fire because
      // Effect.fn-inferred return types collapse to `any` through helper
      // composition. Tests still get the rest of the project lint regime.
      files: ['test/unit/git/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
      },
    },
    {
      // Effect-using files. Mirrors the regime in salesforcedx-vscode/eslint.config.mjs (lines 583-645).
      files: [
        '**/populateTypesAndNames.ts',
        '**/populateTypesAndNamesPerf.nut.ts',
        'src/git/**/*.ts',
        'src/shared/local/localShadowRepoLite.ts',
        'src/shared/local/moveDetectionLite.ts',
      ],
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
        // Effect.fn / Effect.gen frequently produce inferred-as-any types
        // through helper composition. The Effect language server gives
        // accurate diagnostics; the no-unsafe-* rules just create noise here.
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
      },
    },
  ],
};

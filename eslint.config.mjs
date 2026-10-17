import tsconfigs from 'eslint-config-salesforce-typescript';
import plugin from 'eslint-plugin-sf-plugin';
import * as effectPlugin from '@effect/eslint-plugin/plugin';
import functionalPlugin from 'eslint-plugin-functional';
import localRules from './eslint-local-rules/index.js';

const effectFiles = [
  '**/populateTypesAndNames.ts',
  '**/populateTypesAndNamesPerf.nut.ts',
  'src/git/**/*.ts',
  'src/shared/remote/fileOperations.ts',
  'src/shared/remote/orgQueries.ts',
  'src/shared/remote/remoteSourceTracking.ts',
  'src/shared/local/localShadowRepo.ts',
  'src/shared/local/moveDetectionLite.ts',
];

const configs = [
  {
    ignores: ['test/nuts/ebikes-lwc', 'test/nuts/repros/reactinternalapp'],
  },
  ...tsconfigs,
  ...plugin.configs.library,
  {
    files: ['**/*.ts'],
    plugins: {
      '@effect': effectPlugin,
      functional: functionalPlugin,
      'local-rules': { rules: localRules },
    },
  },
  {
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
    files: effectFiles,
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
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
];

export default configs;

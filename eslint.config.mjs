import tsconfigs from 'eslint-config-salesforce-typescript';
import plugin from 'eslint-plugin-sf-plugin';

const configs = [
  {
    ignores: ['test/nuts/ebikes-lwc', 'test/nuts/repros/reactinternalapp'],
  },
  ...tsconfigs,
  ...plugin.configs.library,
];

export default configs;

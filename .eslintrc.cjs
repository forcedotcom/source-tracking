module.exports = {
  extends: ['eslint-config-salesforce-typescript', 'eslint-config-salesforce-license', 'plugin:sf-plugin/library'],
  // ignore eslint files in NUT test repos
  ignorePatterns: ['test/nuts/ebikes-lwc'],
};

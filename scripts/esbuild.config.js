/**
 * NOTE: This file does NOT really generate a bundle version of source-tracking
 * source-tracking is bundled directly in salesforcedx-vscode
 * The file is only used to detect any potential risks to esbuild.
 **/
const { build } = require('esbuild');

const sharedConfig = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: [], // The whitelist of dependencies that are not bundle-able
  keepNames: true,
  plugins: [],
  supported: {
    'dynamic-import': false,
  },
  logOverride: {
    // 'unsupported-dynamic-import': 'error',
  },
};

(async () => {
  await build({
    ...sharedConfig,
    entryPoints: ['./lib/index.js'],
    outdir: 'dist',
  });
})();

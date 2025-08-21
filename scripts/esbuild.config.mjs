import { build } from 'esbuild';

await build({
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
    'unsupported-dynamic-import': 'error',
  },
  entryPoints: ['./lib/index.js'],
  outdir: 'dist',
});

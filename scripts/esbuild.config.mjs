import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const bundle = await build({
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: [], // The whitelist of dependencies that are not bundle-able
  outExtension: { '.js': '.cjs' },
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
  metafile: true,
});

await writeFile('dist/node-metafile.json', JSON.stringify(bundle.metafile, null, 2));

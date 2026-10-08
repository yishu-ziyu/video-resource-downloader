import { build } from 'esbuild';
await build({ entryPoints: ['src/mp4.js'], bundle: true, minify: true, treeShaking: true,
  format: 'esm', platform: 'browser', target: 'chrome116', outfile: 'extension/vendor/mp4.js',
  legalComments: 'eof' });

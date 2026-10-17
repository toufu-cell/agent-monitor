import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, outfile: 'dist/app.js', format: 'esm', minify: true });
await Promise.all(['index.html', 'style.css', 'sw.js', 'manifest.webmanifest', 'icon.svg'].map(name => copyFile(`web/${name}`, `dist/${name}`)));

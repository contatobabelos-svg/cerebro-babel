// Empacota o frontend (uma única cópia do three, com bloom) e copia as fontes locais.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';

await build({
  entryPoints: ['src/main.js'], bundle: true, minify: !process.env.DEV, format: 'iife', target: 'es2020',
  outfile: 'public/app.js', legalComments: 'none', logLevel: 'info',
});
mkdirSync('public/fonts', { recursive: true });
for (const w of [400, 600, 700]) copyFileSync(`node_modules/@fontsource/exo-2/files/exo-2-latin-${w}-normal.woff2`, `public/fonts/exo-2-latin-${w}-normal.woff2`);
for (const w of [400, 500, 600]) copyFileSync(`node_modules/@fontsource/inter/files/inter-latin-${w}-normal.woff2`, `public/fonts/inter-latin-${w}-normal.woff2`);

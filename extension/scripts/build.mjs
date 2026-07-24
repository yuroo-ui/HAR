import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const distDir = join(root, 'dist');
const publicDir = join(root, 'public');
const watch = process.argv.includes('--watch');

const sharedAlias = {
  name: 'shared-alias',
  setup(build) {
    build.onResolve({ filter: /^@har-suite\/shared$/ }, () => ({
      path: resolve(root, '..', 'shared', 'src', 'index.ts'),
    }));
  },
};

async function copyDir(from, to) {
  if (!existsSync(from)) return;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    const src = join(from, entry);
    const dest = join(to, entry);
    const st = await stat(src);
    if (st.isDirectory()) await copyDir(src, dest);
    else await cp(src, dest);
  }
}

async function copyAssets() {
  await copyDir(publicDir, distDir);
  console.log('[build] copied public/ → dist/');
}

const entries = ['src/background.ts', 'src/popup.ts', 'src/content-captcha.ts', 'src/content-js-capture.ts'];
const baseOptions = {
  entryPoints: entries.map((e) => join(root, e)),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  outdir: distDir,
  sourcemap: watch,
  logLevel: 'info',
  plugins: [sharedAlias],
};

if (existsSync(distDir)) await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(baseOptions);
  await copyAssets();
  await ctx.watch();
  console.log('[build] watching...');
  console.log(
    '[dev-hint] After each rebuild, click Reload on chrome://extensions for this extension.',
  );
  console.log('[dev-hint] Or install the "Extensions Reloader" extension and pin its button.');
} else {
  await esbuild.build(baseOptions);
  await copyAssets();
  console.log('[build] done');
}

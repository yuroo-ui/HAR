import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import postcssPresetMantine from 'postcss-preset-mantine';
import postcssSimpleVars from 'postcss-simple-vars';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'src/main/index.ts' },
      rollupOptions: {
        external: [
          'electron',
          'ws',
          'jszip',
          'better-sqlite3',
          'mockttp',
          'koffi',
          'fs',
          'path',
          'os',
          'crypto',
          'child_process',
        ],
      },
    },
    resolve: {
      alias: {
        '@har-suite/shared': resolve(__dirname, '../shared/src/index.ts'),
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: 'src/preload/index.ts' },
      rollupOptions: {
        external: ['electron'],
      },
    },
    resolve: {
      alias: {
        '@har-suite/shared': resolve(__dirname, '../shared/src/index.ts'),
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    css: {
      postcss: {
        plugins: [
          postcssPresetMantine(),
          postcssSimpleVars({
            variables: {
              'mantine-breakpoint-xs': '36em',
              'mantine-breakpoint-sm': '48em',
              'mantine-breakpoint-md': '62em',
              'mantine-breakpoint-lg': '75em',
              'mantine-breakpoint-xl': '88em',
            },
          }),
        ],
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@har-suite/shared': resolve(__dirname, '../shared/src/index.ts'),
      },
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});

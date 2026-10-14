import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const src = resolve(import.meta.dirname, 'src');

export default defineConfig({
  root: src,
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        background: resolve(src, 'background.ts'),
        list: resolve(src, 'ui/index.html'),
        options: resolve(src, 'options/index.html'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.test.ts'],
  },
});

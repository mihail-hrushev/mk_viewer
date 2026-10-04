import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'MKViewer',
      formats: ['es', 'umd'],
      fileName: 'mk-viewer',
    },
    sourcemap: true,
    target: 'es2020',
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

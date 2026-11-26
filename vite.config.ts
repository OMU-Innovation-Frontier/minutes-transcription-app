import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  ...(mode === 'cloudflare' && {
    envDir: false,
    envPrefix: [],
    build: { outDir: 'dist-cloudflare' },
  }),
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
}));

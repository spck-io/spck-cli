import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
    server: {
      deps: {
        inline: ['default-shell', 'os-locale'],
      },
    },
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/__tests__/**'],
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
    },
  },
});

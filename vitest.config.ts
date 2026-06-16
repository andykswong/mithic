import { defineConfig } from 'vitest/config';

// Two project types:
//  - "node": default, runs *.test.ts in Node (replaces `node --test`)
//  - "browser": runs *.browser.test.ts in real Chromium (iframe/DOM/transfer)
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/*/src/**/*.test.ts', 'packages/*/{ts,src}/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'browser',
          include: ['packages/*/src/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});

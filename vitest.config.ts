import { defineConfig } from 'vitest/config';

// Vitest is the test runner for the Isola (Mithic 2.0) packages.
//
// Two project types:
//  - "node":    runs *.test.ts in Node (replaces `node --test` for Isola packages)
//  - "browser": runs *.browser.test.ts in real Chromium (iframe/DOM/transfer)
//
// IMPORTANT: the include globs are an explicit ALLOWLIST of Isola packages, not a
// blanket `packages/*` sweep. Legacy Mithic packages (io, wasip2, process, shell,
// coreutils, jq, curl, worker, examples) still use `node --test` via their own
// package `test` scripts and MUST NOT be picked up here — their suites are written
// for node:test and fail under vitest. As each legacy area is migrated to vitest,
// add its path to the allowlist below (e.g. Group C adds 'packages/io/src/vfs/**').
const ISOLA_PACKAGES = '{protocol,runtime,guest-runtime,kernel,shell-js,server}';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'node',
          include: [`packages/${ISOLA_PACKAGES}/src/**/*.test.ts`],
          exclude: ['**/*.browser.test.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'browser',
          include: [`packages/${ISOLA_PACKAGES}/src/**/*.browser.test.ts`],
          exclude: ['**/node_modules/**', '**/dist/**'],
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

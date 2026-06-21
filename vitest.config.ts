import { defineConfig } from 'vitest/config';

// Vitest is the test runner for the Mithic (Mithic 2.0) packages.
//
// Two project types:
//  - "node":    runs *.test.ts in Node (replaces `node --test` for Mithic packages)
//  - "browser": runs *.browser.test.ts in real Chromium (iframe/DOM/transfer)
//
// IMPORTANT: the include globs are an explicit ALLOWLIST of Mithic packages, not a
// blanket `packages/*` sweep. Legacy Mithic packages (io, wasip2, process, shell,
// coreutils, jq, curl, worker, examples) still use `node --test` via their own
// package `test` scripts and MUST NOT be picked up here — their suites are written
// for node:test and fail under vitest. As each legacy area is migrated to vitest,
// add its path to the allowlist below (e.g. Group C adds 'packages/io/src/vfs/**').
const MITHIC_PACKAGES = '{protocol,runtime,guest-runtime,kernel,shell,coreutils,server}';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'node',
          include: [
            `packages/${MITHIC_PACKAGES}/src/**/*.test.ts`,
            'packages/io/src/vfs/**/*.test.ts',
            // B6 hygiene: io/net tests migrated from node:test to vitest.
            'packages/io/src/net/**/*.test.ts',
            'packages/commands/*/src/**/*.test.ts',
          ],
          exclude: ['**/*.browser.test.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        // Pre-bundle xterm so the notebook browser test doesn't trigger a mid-run
        // Vite dep re-optimization (which warns and can re-run the test).
        optimizeDeps: { include: ['@xterm/xterm'] },
        test: {
          name: 'browser',
          include: [
            `packages/${MITHIC_PACKAGES}/src/**/*.browser.test.ts`,
            'packages/io/src/vfs/**/*.browser.test.ts',
            'packages/commands/*/src/**/*.browser.test.ts',
            // Group P example packages (image-viewer GUI process + xterm notebook + shell).
            'packages/examples/{image-viewer,notebook,shell}/src/**/*.browser.test.ts',
          ],
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

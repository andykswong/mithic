import { test, expect } from 'vitest';
import { bundleGuestEsm } from './bundle-plugin.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('bundleGuestEsm(@mithic/guest-runtime entry) yields a self-contained ESM module with named exports', async () => {
  const entry = resolve(here, '../../../guest-runtime/src/index.ts');
  const src = await bundleGuestEsm(entry);
  expect(src).toContain('export'); // real ESM named exports (NOT the IIFE globalThis footer)
  expect(src).toContain('createGuest');
  expect(src).not.toContain('globalThis.__mithic_default ='); // this is NOT the guest-IIFE form
});

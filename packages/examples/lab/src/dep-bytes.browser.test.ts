import { test, expect } from 'vitest';
import guestRuntimeDep from '../../../guest-runtime/src/index.ts?bundle-esm';

test('the guest-runtime dep bytes import as ESM source text with named exports', () => {
  expect(typeof guestRuntimeDep).toBe('string');
  expect(guestRuntimeDep).toContain('createGuest');
  expect(guestRuntimeDep).toContain('export');
});

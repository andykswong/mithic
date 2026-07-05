import { test, expect } from 'vitest';
import { bundleGuestEsm } from './bundle-plugin.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('bundleGuestEsm(@mithic/guest-runtime entry) yields a self-contained ESM module with named exports', async () => {
  const entry = resolve(here, '../../../guest-runtime/src/index.ts');
  const src = await bundleGuestEsm(entry);
  // A real named-export block: this FAILS if bundleGuestEsm regressed to format:'iife'
  // (that form has no `export { … }`, only the globalThis footer).
  expect(src).toMatch(/export\s*\{[^}]*createGuest/);
  expect(src).toContain('createGuest');
  expect(src).not.toContain('globalThis.__mithic_default ='); // this is NOT the guest-IIFE form
  // §6 self-containment: every transitive dep is inlined — no unresolved specifiers.
  expect(src).not.toMatch(/from\s*['"]@mithic\//); // all @mithic/* deps inlined
  expect(src).not.toMatch(/from\s*['"]node:/); // no node: specifiers (browser target)
  expect(src).not.toContain('require('); // no CJS require
});

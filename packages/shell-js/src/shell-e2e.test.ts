import { expect, test } from 'vitest';
import { runScript } from './index.ts';

test('echo hello | cat produces hello through the real shell', async () => {
  const out = await runScript('echo hello | cat');
  expect(out.stdout.trim()).toBe('hello');
  expect(out.code).toBe(0);
}, 20000);

test('variable assignment and expansion', async () => {
  const out = await runScript('FOO=world; echo $FOO');
  expect(out.stdout.trim()).toBe('world');
}, 20000);

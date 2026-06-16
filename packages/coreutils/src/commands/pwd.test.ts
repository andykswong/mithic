import { expect, test, describe } from 'vitest';
import { pwdCommand } from './pwd.ts';
import { makeIO } from './_testio.ts';

describe('pwd', () => {
  test('prints cwd', async () => {
    const h = makeIO({ args: ['pwd'], cwd: '/home/user' });
    expect(await pwdCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/home/user\n');
  });

  test('defaults to root', async () => {
    const h = makeIO({ args: ['pwd'], cwd: '' });
    await pwdCommand(h.io);
    expect(h.out()).toBe('/\n');
  });

  test('-P accepted', async () => {
    const h = makeIO({ args: ['pwd', '-P'], cwd: '/tmp' });
    expect(await pwdCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/tmp\n');
  });
});

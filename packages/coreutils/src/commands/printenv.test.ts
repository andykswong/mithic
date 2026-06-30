import { expect, test, describe } from 'vitest';
import { printenvCommand } from './printenv.ts';
import { makeIO } from './_testio.ts';

describe('printenv', () => {
  test('no args prints all env as KEY=VALUE sorted', async () => {
    const h = makeIO({ args: ['printenv'], env: { PATH: '/bin', HOME: '/root' } });
    expect(await printenvCommand(h.io)).toBe(0);
    expect(h.out()).toBe('HOME=/root\nPATH=/bin\n');
  });

  test('named var prints its value', async () => {
    const h = makeIO({ args: ['printenv', 'PATH'], env: { PATH: '/usr/bin' } });
    expect(await printenvCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/usr/bin\n');
  });

  test('multiple named vars print one per line', async () => {
    const h = makeIO({ args: ['printenv', 'A', 'B'], env: { A: '1', B: '2' } });
    expect(await printenvCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n');
  });

  test('missing var exits 1 with no output', async () => {
    const h = makeIO({ args: ['printenv', 'MISSING'], env: { PATH: '/bin' } });
    expect(await printenvCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('partial: prints found values but exits 1 if any missing', async () => {
    const h = makeIO({ args: ['printenv', 'A', 'MISSING'], env: { A: 'x' } });
    expect(await printenvCommand(h.io)).toBe(1);
    expect(h.out()).toBe('x\n');
  });
});

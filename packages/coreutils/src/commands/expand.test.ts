import { expect, test, describe } from 'vitest';
import { expandCommand } from './expand.ts';
import { makeIO } from './_testio.ts';

describe('expand', () => {
  test('tab at column 0 becomes 8 spaces (default tabstop)', async () => {
    const h = makeIO({ args: ['expand', '/in'], files: { '/in': '\tx\n' } });
    expect(await expandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('        x\n');
  });

  test('tab after "ab" advances to column 8', async () => {
    const h = makeIO({ args: ['expand', '/in'], files: { '/in': 'ab\tx\n' } });
    await expandCommand(h.io);
    expect(h.out()).toBe('ab      x\n'); // 6 spaces to reach col 8
  });

  test('-t 4 uses a 4-column tabstop', async () => {
    const h = makeIO({ args: ['expand', '-t', '4', '/in'], files: { '/in': 'a\tb\n' } });
    await expandCommand(h.io);
    expect(h.out()).toBe('a   b\n'); // 3 spaces to reach col 4
  });

  test('reads stdin', async () => {
    const h = makeIO({ args: ['expand'], stdinText: '\t!' });
    await expandCommand(h.io);
    expect(h.out()).toBe('        !');
  });
});

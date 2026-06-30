import { expect, test, describe } from 'vitest';
import { odCommand } from './od.ts';
import { makeIO } from './_testio.ts';

describe('od', () => {
  // Expected strings are GNU coreutils `od` output (the reference the command
  // targets — see od.ts header). BSD/macOS od spaces columns differently.
  test('-A x -t x1 of "AB"', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe('000000 41 42\n000002\n');
  });

  test('-A x -t x1 wraps at 16 bytes per line', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': '0123456789ABCDEFG' } });
    await odCommand(h.io);
    expect(h.out()).toBe(
      '000000 30 31 32 33 34 35 36 37 38 39 41 42 43 44 45 46\n' +
      '000010 47\n' +
      '000011\n',
    );
  });

  test('-c of "A\\nB" (default octal address)', async () => {
    const h = makeIO({ args: ['od', '-c', '/in'], files: { '/in': 'A\nB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe('0000000   A  \\n   B\n0000003\n');
  });

  test('-A d decimal address radix', async () => {
    const h = makeIO({ args: ['od', '-A', 'd', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    await odCommand(h.io);
    expect(h.out()).toBe('0000000 41 42\n0000002\n');
  });

  test('-A n suppresses the address column', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    await odCommand(h.io);
    expect(h.out()).toBe(' 41 42\n');
  });

  test('-t o1 octal bytes', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'o1', '/in'], files: { '/in': 'AB' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000 101 102\n000002\n');
  });

  test('reads stdin when no file operand', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1'], stdinText: 'AB' });
    await odCommand(h.io);
    expect(h.out()).toBe('000000 41 42\n000002\n');
  });

  test('empty input prints just the final address', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': '' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000\n');
  });
});

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

  describe('-t LIST', () => {
    test('explicit stop columns', async () => {
      const h = makeIO({ args: ['expand', '-t', '1,3'], stdinText: 'a\tb\tc\td\n' });
      expect(await expandCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a  b c d\n');
    });
    test('past the last stop advances by one column', async () => {
      const h = makeIO({ args: ['expand', '-t', '4,8'], stdinText: '\t\t\t\tX\n' });
      await expandCommand(h.io);
      expect(h.out()).toBe('          X\n'); // 4 + 4 + 1 + 1 = 10 spaces
    });
    test('whitespace-separated list', async () => {
      const h = makeIO({ args: ['expand', '-t', '2 5 8'], stdinText: 'a\tb\tc\n' });
      await expandCommand(h.io);
      expect(h.out()).toBe('a b  c\n');
    });
    test('repeated -t flags accumulate', async () => {
      const h = makeIO({ args: ['expand', '-t', '3', '-t', '6'], stdinText: 'a\tb\tc\n' });
      await expandCommand(h.io);
      expect(h.out()).toBe('a  b  c\n');
    });
    test('tab size 0 is rejected', async () => {
      const h = makeIO({ args: ['expand', '-t', '0'], stdinText: 'a\tb\n' });
      expect(await expandCommand(h.io)).toBe(1);
      expect(h.err()).toContain('expand: tab size cannot be 0');
    });
    test('non-ascending list is rejected', async () => {
      const h = makeIO({ args: ['expand', '-t', '5,3'], stdinText: 'a\tb\n' });
      expect(await expandCommand(h.io)).toBe(1);
      expect(h.err()).toContain('expand: tab sizes must be ascending');
    });
    test('non-numeric list token is rejected', async () => {
      const h = makeIO({ args: ['expand', '-t', 'x'], stdinText: 'a\tb\n' });
      expect(await expandCommand(h.io)).toBe(1);
      expect(h.err()).toContain('expand: tab size contains invalid character(s): ‘x’');
    });
  });

  describe('-i (initial only)', () => {
    test('converts leading tabs, leaves embedded tabs', async () => {
      const h = makeIO({ args: ['expand', '-i'], stdinText: 'a\tb\tc\n' });
      expect(await expandCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\tb\tc\n');
    });
    test('converts a run of leading tabs', async () => {
      const h = makeIO({ args: ['expand', '-i'], stdinText: '\t\ta\tb\n' });
      await expandCommand(h.io);
      expect(h.out()).toBe('                a\tb\n');
    });
  });

  test('unknown flag exits 1', async () => {
    const h = makeIO({ args: ['expand', '-Q'], stdinText: 'x\n' });
    expect(await expandCommand(h.io)).toBe(1);
    expect(h.err()).toContain('expand: invalid option -- \'Q\'');
  });
});

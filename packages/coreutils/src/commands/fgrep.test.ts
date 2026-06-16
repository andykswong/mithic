import { expect, test, describe } from 'vitest';
import { grepCommand } from './fgrep.ts';
import { makeIO } from './_test-io.ts';

describe('fgrep (grep -F)', () => {
  test('treats the pattern as a literal string', async () => {
    // `a.c` matches literally; `abc` does not (the `.` is not a wildcard).
    const h = makeIO({ args: ['fgrep', 'a.c'], stdinText: 'a.c\nabc\nxyz\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a.c\n');
  });

  test('regex metacharacters are literal', async () => {
    const h = makeIO({ args: ['fgrep', 'a*b'], stdinText: 'a*b\naaab\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a*b\n');
  });

  test('no match returns exit 1', async () => {
    const h = makeIO({ args: ['fgrep', 'zzz'], stdinText: 'foo\nbar\n' });
    expect(await grepCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('-v inverts the literal match', async () => {
    const h = makeIO({ args: ['fgrep', '-v', 'a.c'], stdinText: 'a.c\nabc\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc\n');
  });
});

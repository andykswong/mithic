import { expect, test, describe } from 'vitest';
import { uniqCommand } from './uniq.ts';
import { makeIO } from './_test-io.ts';

describe('uniq', () => {
  test('collapses adjacent duplicates', async () => {
    const h = makeIO({ args: ['uniq'], stdinText: 'a\na\nb\nb\nb\nc\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\nc\n');
  });

  test('non-adjacent duplicates kept (uniq is adjacency-based)', async () => {
    const h = makeIO({ args: ['uniq'], stdinText: 'a\nb\na\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\na\n');
  });

  test('-c prefixes counts', async () => {
    const h = makeIO({ args: ['uniq', '-c'], stdinText: 'a\na\nb\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      2 a\n      1 b\n');
  });

  test('-d only duplicated lines', async () => {
    const h = makeIO({ args: ['uniq', '-d'], stdinText: 'a\na\nb\nc\nc\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nc\n');
  });

  test('-u only unique lines', async () => {
    const h = makeIO({ args: ['uniq', '-u'], stdinText: 'a\na\nb\nc\nc\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });

  test('-i ignores case', async () => {
    const h = makeIO({ args: ['uniq', '-i'], stdinText: 'Foo\nfoo\nbar\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Foo\nbar\n');
  });

  test('-f skips fields', async () => {
    const h = makeIO({ args: ['uniq', '-f', '1'], stdinText: 'x a\ny a\nz b\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    // compares after first field: "a","a","b" → first of each group
    expect(h.out()).toBe('x a\nz b\n');
  });

  test('-s skips chars', async () => {
    const h = makeIO({ args: ['uniq', '-s', '1'], stdinText: '1abc\n2abc\n3xyz\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1abc\n3xyz\n');
  });

  test('reads from file', async () => {
    const h = makeIO({ args: ['uniq', '/a'], files: { '/a': 'p\np\nq\n' } });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('p\nq\n');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['uniq', '/missing'] });
    expect(await uniqCommand(h.io)).toBe(1);
    expect(h.err()).toContain('uniq: /missing:');
  });

  test('missing file uses canonical errno text', async () => {
    const h = makeIO({ args: ['uniq', '/missing'] });
    expect(await uniqCommand(h.io)).toBe(1);
    expect(h.err()).toBe('uniq: /missing: No such file or directory\n');
  });

  // ── -D / --all-repeated ───────────────────────────────────────────────────
  test('-D prints all lines of duplicated groups (none)', async () => {
    const h = makeIO({ args: ['uniq', '-D'], stdinText: 'a\na\nb\nc\nc\nc\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\na\nc\nc\nc\n');
  });

  test('--all-repeated=prepend blank-lines before each group', async () => {
    const h = makeIO({ args: ['uniq', '--all-repeated=prepend'], stdinText: 'a\na\nb\nc\nc\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\na\na\n\nc\nc\n');
  });

  test('--all-repeated=separate blank-lines between groups', async () => {
    const h = makeIO({ args: ['uniq', '--all-repeated=separate'], stdinText: 'a\na\nb\nb\nc\nd\nd\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\na\n\nb\nb\n\nd\nd\n');
  });

  test('bare --all-repeated == none', async () => {
    const h = makeIO({ args: ['uniq', '--all-repeated'], stdinText: 'a\na\nb\nc\nc\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\na\nc\nc\n');
  });

  test('--all-repeated=bogus is an error', async () => {
    const h = makeIO({ args: ['uniq', '--all-repeated=bogus'], stdinText: 'a\na\n' });
    expect(await uniqCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid argument ‘bogus’ for ‘--all-repeated’');
  });

  test('-D with -c is meaningless (error)', async () => {
    const h = makeIO({ args: ['uniq', '-D', '-c'], stdinText: 'a\na\n' });
    expect(await uniqCommand(h.io)).toBe(1);
    expect(h.err()).toBe('uniq: printing all duplicated lines and repeat counts is meaningless\nTry \'uniq --help\' for more information.\n');
  });

  // ── --group ───────────────────────────────────────────────────────────────
  test('--group prints all groups blank-separated', async () => {
    const h = makeIO({ args: ['uniq', '--group'], stdinText: 'a\na\nb\nc\nc\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\na\n\nb\n\nc\nc\n');
  });

  test('--group=prepend', async () => {
    const h = makeIO({ args: ['uniq', '--group=prepend'], stdinText: 'a\na\nb\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\na\na\n\nb\n');
  });

  test('--group=append', async () => {
    const h = makeIO({ args: ['uniq', '--group=append'], stdinText: 'a\na\nb\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\na\n\nb\n\n');
  });

  test('--group=both prepends each and appends once (no doubled blank)', async () => {
    const h = makeIO({ args: ['uniq', '--group=both'], stdinText: 'a\na\nb\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\na\na\n\nb\n\n');
  });

  test('--group is mutually exclusive with -c', async () => {
    const h = makeIO({ args: ['uniq', '--group', '-c'], stdinText: 'a\n' });
    expect(await uniqCommand(h.io)).toBe(1);
    expect(h.err()).toBe('uniq: --group is mutually exclusive with -c/-d/-D/-u\nTry \'uniq --help\' for more information.\n');
  });

  test('--group=bogus is an error', async () => {
    const h = makeIO({ args: ['uniq', '--group=bogus'], stdinText: 'a\n' });
    expect(await uniqCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid argument ‘bogus’ for ‘--group’');
  });

  // ── -w (compare first N chars) ────────────────────────────────────────────
  test('-w 1 compares only the first char (prints full line)', async () => {
    const h = makeIO({ args: ['uniq', '-w', '1'], stdinText: 'apple\nation\nbanana\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('apple\nbanana\n');
  });

  test('-w 0 makes all lines compare equal', async () => {
    const h = makeIO({ args: ['uniq', '-w', '0'], stdinText: 'a\nb\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\n');
  });

  test('-c -w combined', async () => {
    const h = makeIO({ args: ['uniq', '-c', '-w', '2'], stdinText: 'apple\napron\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      2 apple\n');
  });

  // ── -z (NUL delimiter) ────────────────────────────────────────────────────
  test('-z uses NUL line delimiter', async () => {
    const h = makeIO({ args: ['uniq', '-z'], stdinText: 'a\0a\0b\0' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\0b\0');
  });

  test('-z -c NUL-delimited counts', async () => {
    const h = makeIO({ args: ['uniq', '-z', '-c'], stdinText: 'a\0a\0b\0' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      2 a\0      1 b\0');
  });

  // ── -d -u together = nothing ──────────────────────────────────────────────
  test('-d -u together prints nothing', async () => {
    const h = makeIO({ args: ['uniq', '-d', '-u'], stdinText: 'a\na\nb\n' });
    expect(await uniqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  // ── numeric-argument validation for -f/-s/-w (GNU parity) ─────────────────
  describe('invalid numeric arguments', () => {
    test('-f abc → invalid number of fields to skip', async () => {
      const h = makeIO({ args: ['uniq', '-f', 'abc'], stdinText: 'a\n' });
      expect(await uniqCommand(h.io)).toBe(1);
      expect(h.err()).toBe('uniq: abc: invalid number of fields to skip\n');
    });
    test('-f 1x → invalid (trailing junk)', async () => {
      const h = makeIO({ args: ['uniq', '-f', '1x'], stdinText: 'a\n' });
      expect(await uniqCommand(h.io)).toBe(1);
      expect(h.err()).toBe('uniq: 1x: invalid number of fields to skip\n');
    });
    test('-f -1 → invalid (negative)', async () => {
      const h = makeIO({ args: ['uniq', '-f', '-1'], stdinText: 'a\n' });
      expect(await uniqCommand(h.io)).toBe(1);
      expect(h.err()).toBe('uniq: -1: invalid number of fields to skip\n');
    });
    test('-s abc → invalid number of bytes to skip', async () => {
      const h = makeIO({ args: ['uniq', '-s', 'abc'], stdinText: 'a\n' });
      expect(await uniqCommand(h.io)).toBe(1);
      expect(h.err()).toBe('uniq: abc: invalid number of bytes to skip\n');
    });
    test('-w abc → invalid number of bytes to compare', async () => {
      const h = makeIO({ args: ['uniq', '-w', 'abc'], stdinText: 'a\n' });
      expect(await uniqCommand(h.io)).toBe(1);
      expect(h.err()).toBe('uniq: abc: invalid number of bytes to compare\n');
    });
    test('-w 2k → suffix rejected (no size-suffix support)', async () => {
      const h = makeIO({ args: ['uniq', '-w', '2k'], stdinText: 'a\n' });
      expect(await uniqCommand(h.io)).toBe(1);
      expect(h.err()).toBe('uniq: 2k: invalid number of bytes to compare\n');
    });
    test('valid: -f 007 (leading zeros) accepted', async () => {
      const h = makeIO({ args: ['uniq', '-f', '007'], stdinText: 'x a\ny a\n' });
      expect(await uniqCommand(h.io)).toBe(0);
      expect(h.out()).toBe('x a\n');
    });
    test('valid: -f +1 (leading plus) accepted', async () => {
      const h = makeIO({ args: ['uniq', '-f', '+1'], stdinText: 'x a\ny a\n' });
      expect(await uniqCommand(h.io)).toBe(0);
      expect(h.out()).toBe('x a\n');
    });
    test('valid: -w 0 collapses all lines', async () => {
      const h = makeIO({ args: ['uniq', '-w', '0'], stdinText: 'a\nb\n' });
      expect(await uniqCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\n');
    });
  });

  // ── M7: unknown options are rejected (exit 1) ───────────────────────────────
  describe('unknown option rejection', () => {
    test('long unknown option → exit 1 + unrecognized diagnostic', async () => {
      const h = makeIO({ args: ['uniq', '--bogus'], stdinText: 'a\n' });
      expect(await uniqCommand(h.io)).toBe(1);
      expect(h.err()).toBe('uniq: unrecognized option \'--bogus\'\nTry \'uniq --help\' for more information.\n');
    });
    test('short unknown option → exit 1 + invalid-option diagnostic', async () => {
      const h = makeIO({ args: ['uniq', '-Z'], stdinText: 'a\n' });
      expect(await uniqCommand(h.io)).toBe(1);
      expect(h.err()).toBe('uniq: invalid option -- \'Z\'\nTry \'uniq --help\' for more information.\n');
    });
  });
});

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
});

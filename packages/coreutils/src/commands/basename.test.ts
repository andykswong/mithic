import { expect, test, describe } from 'vitest';
import { basenameCommand, posixBasename } from './basename.ts';
import { makeIO } from './_testio.ts';

describe('posixBasename', () => {
  test('all-slash paths collapse to /', () => {
    expect(posixBasename('//')).toBe('/');
    expect(posixBasename('/')).toBe('/');
    expect(posixBasename('///')).toBe('/');
  });
  test('internal and trailing slashes', () => {
    expect(posixBasename('a//b//c')).toBe('c');
    expect(posixBasename('foo//bar//')).toBe('bar');
    expect(posixBasename('/usr//lib')).toBe('lib');
    expect(posixBasename('//foo')).toBe('foo');
    expect(posixBasename('foo//')).toBe('foo');
    expect(posixBasename('a/b//')).toBe('b');
    expect(posixBasename('///foo///')).toBe('foo');
  });
  test('empty string stays empty', () => {
    expect(posixBasename('')).toBe('');
  });
});

describe('basename', () => {
  test('strips directory', async () => {
    const h = makeIO({ args: ['basename', '/usr/bin/sort'] });
    expect(await basenameCommand(h.io)).toBe(0);
    expect(h.out()).toBe('sort\n');
  });

  test('strips suffix', async () => {
    const h = makeIO({ args: ['basename', '/a/b/file.txt', '.txt'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('file\n');
  });

  test('does not strip when name equals suffix', async () => {
    const h = makeIO({ args: ['basename', '.txt', '.txt'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('.txt\n');
  });

  test('-a multiple', async () => {
    const h = makeIO({ args: ['basename', '-a', '/x/y', '/p/q'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('y\nq\n');
  });

  test('-s suffix implies -a', async () => {
    const h = makeIO({ args: ['basename', '-s', '.c', 'a.c', 'b.c'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('a\nb\n');
  });

  test('trailing slash', async () => {
    const h = makeIO({ args: ['basename', '/a/b/'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('b\n');
  });

  test('// resolves to / (not empty)', async () => {
    const h = makeIO({ args: ['basename', '//'] });
    expect(await basenameCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/\n');
  });

  test('collapses internal duplicate slashes to the last component', async () => {
    const h = makeIO({ args: ['basename', '/usr//lib'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('lib\n');
  });

  test('missing operand errors', async () => {
    const h = makeIO({ args: ['basename'] });
    expect(await basenameCommand(h.io)).toBe(1);
    expect(h.err()).toContain('missing operand');
  });

  // GNU parity: unknown options are rejected (not silently swallowed).
  test('an unknown short flag errors like GNU (exit 1, nothing on stdout)', async () => {
    const h = makeIO({ args: ['basename', '-x', '/a/b'] });
    expect(await basenameCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toBe('basename: invalid option -- \'x\'\nTry \'basename --help\' for more information.\n');
  });

  test('an unknown long flag errors like GNU (exit 1)', async () => {
    const h = makeIO({ args: ['basename', '--bogus', '/a/b'] });
    expect(await basenameCommand(h.io)).toBe(1);
    expect(h.err()).toBe('basename: unrecognized option \'--bogus\'\nTry \'basename --help\' for more information.\n');
  });
});

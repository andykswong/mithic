import { expect, test, describe } from 'vitest';
import { dirnameCommand, posixDirname } from './dirname.ts';
import { makeIO } from './_testio.ts';

describe('posixDirname', () => {
  test('preserves internal duplicate slashes in the surviving prefix', () => {
    expect(posixDirname('a//b//c')).toBe('a//b');
  });
  test('all-slash paths collapse to /', () => {
    expect(posixDirname('//')).toBe('/');
    expect(posixDirname('/')).toBe('/');
    expect(posixDirname('///')).toBe('/');
  });
  test('trailing-slash and multi-slash edge cases', () => {
    expect(posixDirname('foo//bar//')).toBe('foo');
    expect(posixDirname('/usr//lib')).toBe('/usr');
    expect(posixDirname('//foo')).toBe('/');
    expect(posixDirname('foo//')).toBe('.');
    expect(posixDirname('a/b//')).toBe('a');
    expect(posixDirname('///foo///')).toBe('/');
    expect(posixDirname('foo')).toBe('.');
    expect(posixDirname('/foo')).toBe('/');
  });
});

describe('dirname', () => {
  test('strips last component', async () => {
    const h = makeIO({ args: ['dirname', '/a/b/c'] });
    expect(await dirnameCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a/b\n');
  });

  test('no slash yields dot', async () => {
    const h = makeIO({ args: ['dirname', 'file'] });
    await dirnameCommand(h.io);
    expect(h.out()).toBe('.\n');
  });

  test('root stays root', async () => {
    const h = makeIO({ args: ['dirname', '/x'] });
    await dirnameCommand(h.io);
    expect(h.out()).toBe('/\n');
  });

  test('multiple operands', async () => {
    const h = makeIO({ args: ['dirname', '/a/b', '/c/d'] });
    await dirnameCommand(h.io);
    expect(h.out()).toBe('/a\n/c\n');
  });

  test('preserves internal duplicate slashes (a//b//c → a//b)', async () => {
    const h = makeIO({ args: ['dirname', 'a//b//c'] });
    expect(await dirnameCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a//b\n');
  });

  test('// stays /', async () => {
    const h = makeIO({ args: ['dirname', '//'] });
    await dirnameCommand(h.io);
    expect(h.out()).toBe('/\n');
  });

  test('multiple multi-slash operands', async () => {
    const h = makeIO({ args: ['dirname', 'foo//bar//', '/usr//lib', '//foo'] });
    await dirnameCommand(h.io);
    expect(h.out()).toBe('foo\n/usr\n/\n');
  });

  test('missing operand errors', async () => {
    const h = makeIO({ args: ['dirname'] });
    expect(await dirnameCommand(h.io)).toBe(1);
  });
});

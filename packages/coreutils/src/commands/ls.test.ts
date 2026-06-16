import { expect, test, describe } from 'vitest';
import { lsCommand, columns, permString, humanSize } from './ls.ts';
import { makeIO } from './_testio.ts';

describe('ls helpers', () => {
  test('permString', () => {
    expect(permString('file', 0o644)).toBe('-rw-r--r--');
    expect(permString('directory', 0o755)).toBe('drwxr-xr-x');
    expect(permString('symlink', 0o777)).toBe('lrwxrwxrwx');
  });
  test('humanSize', () => {
    expect(humanSize(512)).toBe('512');
    expect(humanSize(1536)).toBe('1.5K');
    expect(humanSize(1048576)).toBe('1.0M');
  });
  test('columns wraps and newline-terminates', () => {
    const c = columns(['a', 'b']);
    expect(c.endsWith('\n')).toBe(true);
  });
});

describe('ls', () => {
  test('lists directory entries sorted', async () => {
    const h = makeIO({ args: ['ls', '-1', '/d'], files: { '/d/b': '1', '/d/a': '2' } });
    expect(await lsCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('hides dotfiles by default, -a shows them', async () => {
    const h1 = makeIO({ args: ['ls', '-1', '/d'], files: { '/d/.hidden': 'x', '/d/visible': 'y' } });
    await lsCommand(h1.io);
    expect(h1.out()).toBe('visible\n');

    const h2 = makeIO({ args: ['ls', '-1', '-a', '/d'], files: { '/d/.hidden': 'x', '/d/visible': 'y' } });
    await lsCommand(h2.io);
    expect(h2.out().split('\n')).toContain('.hidden');
    expect(h2.out().split('\n')).toContain('.');
  });

  test('-l long format shows perms and size', async () => {
    const h = makeIO({ args: ['ls', '-l', '/d'], files: { '/d/f': { content: 'hello', mode: 0o644 } } });
    await lsCommand(h.io);
    expect(h.out()).toContain('-rw-r--r--');
    expect(h.out()).toContain(' 5 ');
  });

  test('-d lists directory itself', async () => {
    const h = makeIO({ args: ['ls', '-d', '/d'], files: { '/d/x': 'x' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('/d\n');
  });

  test('-r reverses order', async () => {
    const h = makeIO({ args: ['ls', '-1', '-r', '/d'], files: { '/d/a': '1', '/d/b': '2' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('b\na\n');
  });

  test('-S sorts by size descending', async () => {
    const h = makeIO({ args: ['ls', '-1', '-S', '/d'], files: { '/d/small': 'x', '/d/big': 'xxxxx' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('big\nsmall\n');
  });

  test('-R recurses with headers', async () => {
    const h = makeIO({ args: ['ls', '-1', '-R', '/d'], files: { '/d/a': '1', '/d/sub/b': '2' } });
    await lsCommand(h.io);
    expect(h.out()).toContain('/d/sub:');
    expect(h.out()).toContain('b');
  });

  test('lists a single file operand', async () => {
    const h = makeIO({ args: ['ls', '-1', '/f'], files: { '/f': 'x' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('/f\n');
  });

  test('missing target errors', async () => {
    const h = makeIO({ args: ['ls', '/nope'] });
    expect(await lsCommand(h.io)).toBe(1);
    expect(h.err()).toContain('cannot access');
  });
});

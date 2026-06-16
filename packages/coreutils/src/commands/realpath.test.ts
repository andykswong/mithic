import { expect, test, describe } from 'vitest';
import { realpathCommand } from './realpath.ts';
import { makeIO } from './_testio.ts';

describe('realpath', () => {
  test('resolves an existing path', async () => {
    const h = makeIO({ args: ['realpath', '/a/b'], files: { '/a/b': 'x' } });
    expect(await realpathCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a/b\n');
  });

  test('resolves through a symlink', async () => {
    const h = makeIO({ args: ['realpath', '/link'], files: { '/dir/file': 'x' } });
    await h.fs.symlink('/dir/file', '/link');
    expect(await realpathCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/dir/file\n');
  });

  test('missing path errors by default', async () => {
    const h = makeIO({ args: ['realpath', '/nope'] });
    expect(await realpathCommand(h.io)).toBe(1);
  });

  test('-m allows missing path', async () => {
    const h = makeIO({ args: ['realpath', '-m', '/x/../y/z'] });
    expect(await realpathCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/y/z\n');
  });

  test('-q suppresses error message', async () => {
    const h = makeIO({ args: ['realpath', '-q', '/nope'] });
    expect(await realpathCommand(h.io)).toBe(1);
    expect(h.err()).toBe('');
  });
});

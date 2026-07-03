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

  test('default allows a missing final under an existing parent (GNU parity)', async () => {
    // GNU realpath default = readlink -f: only the parent must exist.
    const h = makeIO({ args: ['realpath', '/nope'] });
    expect(await realpathCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/nope\n');
  });

  test('default errors when an intermediate component is missing', async () => {
    const h = makeIO({ args: ['realpath', '/nodir/leaf'] });
    expect(await realpathCommand(h.io)).toBe(1);
  });

  test('-m allows missing path', async () => {
    const h = makeIO({ args: ['realpath', '-m', '/x/../y/z'] });
    expect(await realpathCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/y/z\n');
  });

  test('-q suppresses error message on a missing intermediate', async () => {
    const h = makeIO({ args: ['realpath', '-q', '/nodir/leaf'] });
    expect(await realpathCommand(h.io)).toBe(1);
    expect(h.err()).toBe('');
  });

  // ── default intermediate-existence check ────────────────────────────────────

  test('default allows a missing final component', async () => {
    const h = makeIO({ args: ['realpath', '/dir/newfile'], files: { '/dir/file': 'x' } });
    expect(await realpathCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/dir/newfile\n');
  });

  test('default fails when an intermediate component is missing', async () => {
    const h = makeIO({ args: ['realpath', '/a/nodir/newfile'], files: { '/a/b/keep': '1' } });
    expect(await realpathCommand(h.io)).toBe(1);
    expect(h.err()).toBe('realpath: /a/nodir/newfile: No such file or directory\n');
  });

  // ── -e requires every component ─────────────────────────────────────────────

  test('-e fails on a missing final component', async () => {
    const h = makeIO({ args: ['realpath', '-e', '/dir/newfile'], files: { '/dir/file': 'x' } });
    expect(await realpathCommand(h.io)).toBe(1);
    expect(h.err()).toContain('No such file or directory');
  });

  test('-e succeeds when all components exist', async () => {
    const h = makeIO({ args: ['realpath', '-e', '/dir/file'], files: { '/dir/file': 'x' } });
    expect(await realpathCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/dir/file\n');
  });

  // ── --relative-to / --relative-base ─────────────────────────────────────────

  test('--relative-to prints a path relative to the anchor', async () => {
    const h = makeIO({
      args: ['realpath', '--relative-to=/a/b', '/x/y'],
      files: { '/a/b/keep': '1', '/x/y/keep': '1' },
    });
    expect(await realpathCommand(h.io)).toBe(0);
    expect(h.out()).toBe('../../x/y\n');
  });

  test('--relative-base relativizes only when the path is inside the base', async () => {
    const inside = makeIO({ args: ['realpath', '--relative-base=/a', '/a/b/c'], files: { '/a/b/c/keep': '1' } });
    await realpathCommand(inside.io);
    expect(inside.out()).toBe('b/c\n');

    const outside = makeIO({
      args: ['realpath', '--relative-base=/a', '/x/y'],
      files: { '/a/keep': '1', '/x/y/keep': '1' },
    });
    await realpathCommand(outside.io);
    expect(outside.out()).toBe('/x/y\n'); // not under /a → absolute
  });

  // ── -z NUL terminator ───────────────────────────────────────────────────────

  test('-z ends output with NUL', async () => {
    const h = makeIO({ args: ['realpath', '-z', '/dir/file'], files: { '/dir/file': 'x' } });
    await realpathCommand(h.io);
    expect(h.out()).toBe('/dir/file\x00');
  });

  test('unknown flag → exit 1', async () => {
    const h = makeIO({ args: ['realpath', '--bogus', '/x'], files: { '/x': '1' } });
    expect(await realpathCommand(h.io)).toBe(1);
    expect(h.err()).toContain('unrecognized option \'--bogus\'');
  });
});

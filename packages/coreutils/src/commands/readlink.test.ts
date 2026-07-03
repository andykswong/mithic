import { expect, test, describe } from 'vitest';
import { readlinkCommand } from './readlink.ts';
import { makeIO } from './_testio.ts';

describe('readlink', () => {
  test('prints symlink target', async () => {
    const h = makeIO({ args: ['readlink', '/link'], files: { '/target': 'x' } });
    await h.fs.symlink('/target', '/link');
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/target\n');
  });

  test('-n omits trailing newline', async () => {
    const h = makeIO({ args: ['readlink', '-n', '/link'] });
    await h.fs.symlink('/t', '/link');
    await readlinkCommand(h.io);
    expect(h.out()).toBe('/t');
  });

  test('-f canonicalizes through symlink', async () => {
    const h = makeIO({ args: ['readlink', '-f', '/link'], files: { '/dir/file': 'x' } });
    await h.fs.symlink('/dir/file', '/link');
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/dir/file\n');
  });

  test('non-link returns 1 with no output', async () => {
    const h = makeIO({ args: ['readlink', '/f'], files: { '/f': 'x' } });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('missing operand', async () => {
    const h = makeIO({ args: ['readlink'] });
    expect(await readlinkCommand(h.io)).toBe(1);
  });

  // ── -e / -m / -f canonicalization ───────────────────────────────────────────

  test('-e requires the final component to exist (fails on a missing final)', async () => {
    const h = makeIO({ args: ['readlink', '-e', '/dir/nope'], files: { '/dir/file': 'x' } });
    // Parent exists, final missing → GNU -e exits 1 with no output.
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('-e prints the canonical path when everything exists', async () => {
    const h = makeIO({ args: ['readlink', '-e', '/dir/file'], files: { '/dir/file': 'x' } });
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/dir/file\n');
  });

  test('-e resolves symlinks along the way', async () => {
    const h = makeIO({ args: ['readlink', '-e', '/link'], files: { '/dir/file': 'x' } });
    await h.fs.symlink('/dir/file', '/link');
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/dir/file\n');
  });

  test('-m never fails and canonicalizes a fully-missing path', async () => {
    const h = makeIO({ args: ['readlink', '-m', '/a/b/c'] });
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a/b/c\n');
  });

  test('-m collapses . and .. in the missing tail', async () => {
    const h = makeIO({ args: ['readlink', '-m', '/dir/x/../y'], files: { '/dir/file': 'x' } });
    await readlinkCommand(h.io);
    expect(h.out()).toBe('/dir/y\n');
  });

  test('-f allows a missing final component but requires the parent', async () => {
    const h = makeIO({ args: ['readlink', '-f', '/dir/newfile'], files: { '/dir/file': 'x' } });
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/dir/newfile\n');
  });

  test('-f fails when an intermediate component is missing', async () => {
    const h = makeIO({ args: ['readlink', '-f', '/nodir/newfile'], files: { '/dir/file': 'x' } });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('unknown flag → exit 1', async () => {
    const h = makeIO({ args: ['readlink', '--bogus', '/x'] });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.err()).toContain('unrecognized option \'--bogus\'');
  });

  // ── -v/--verbose: print the per-operand diagnostic (GNU parity) ──

  test('default is quiet on a missing operand (no stderr)', async () => {
    const h = makeIO({ args: ['readlink', '/missing'] });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.err()).toBe('');
  });

  test('-v prints "No such file or directory" for a missing operand', async () => {
    const h = makeIO({ args: ['readlink', '-v', '/missing'] });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.err()).toBe('readlink: /missing: No such file or directory\n');
  });

  test('--verbose prints "Invalid argument" for a non-symlink', async () => {
    const h = makeIO({ args: ['readlink', '--verbose', '/f'], files: { '/f': 'x' } });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.err()).toBe('readlink: /f: Invalid argument\n');
  });

  test('-q -v: verbose still prints (overrides the quiet default)', async () => {
    const h = makeIO({ args: ['readlink', '-q', '-v', '/missing'] });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.err()).toBe('readlink: /missing: No such file or directory\n');
  });

  test('-v success on a real symlink prints no error', async () => {
    const h = makeIO({ args: ['readlink', '-v', '/link'], files: { '/target': 'x' } });
    await h.fs.symlink('/target', '/link');
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/target\n');
    expect(h.err()).toBe('');
  });

  test('-e -v prints the diagnostic when the final component is missing', async () => {
    const h = makeIO({ args: ['readlink', '-e', '-v', '/dir/nope'], files: { '/dir/file': 'x' } });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.err()).toBe('readlink: /dir/nope: No such file or directory\n');
  });
});

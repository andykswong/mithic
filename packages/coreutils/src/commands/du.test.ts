import { expect, test, describe } from 'vitest';
import { duCommand } from './du.ts';
import { makeIO } from './_testio.ts';

// Model under test (documented in du.ts header): block size = ceil(byte-sum /
// 1024). Real GNU st_blocks accounting is not reproducible on a virtual FS.
const A = 'a'.repeat(2048);
const B = 'b'.repeat(1024);
const tree = { '/d/a': A, '/d/sub/b': B };

describe('du', () => {
  test('-s prints one cumulative total per argument', async () => {
    const h = makeIO({ args: ['du', '-s', '/d'], files: tree });
    expect(await duCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3\t/d\n');
  });

  test('default lists each subdir (children first) then the argument', async () => {
    const h = makeIO({ args: ['du', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('1\t/d/sub\n3\t/d\n');
  });

  test('-a includes individual files', async () => {
    const h = makeIO({ args: ['du', '-a', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('2\t/d/a\n1\t/d/sub/b\n1\t/d/sub\n3\t/d\n');
  });

  test('-h human-readable', async () => {
    const h = makeIO({ args: ['du', '-sh', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('3.0K\t/d\n');
  });

  test('ceil: 1500 bytes rounds up to 2 KiB', async () => {
    const h = makeIO({ args: ['du', '-s', '/f'], files: { '/f': 'x'.repeat(1500) } });
    await duCommand(h.io);
    expect(h.out()).toBe('2\t/f\n');
  });

  // ── new GNU-parity flags ────────────────────────────────────────────────────

  test('-b apparent byte size (exact, not block-rounded)', async () => {
    const h = makeIO({ args: ['du', '-b', '/d'], files: tree });
    expect(await duCommand(h.io)).toBe(0);
    // /d/sub = 1024 bytes (just b); /d = 3072 bytes (a=2048 + b=1024).
    expect(h.out()).toBe('1024\t/d/sub\n3072\t/d\n');
  });

  test('-c appends a grand total line', async () => {
    const h = makeIO({ args: ['du', '-b', '-c', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('1024\t/d/sub\n3072\t/d\n3072\ttotal\n');
  });

  test('-c block-mode total sums per-arg block counts (not summed bytes)', async () => {
    // Two 1500-byte files: each ceil(1500/1024)=2 blocks; total = 2+2 = 4
    // (NOT ceil(3000/1024)=3).
    const h = makeIO({ args: ['du', '-c', '/a', '/b'], files: { '/a': 'x'.repeat(1500), '/b': 'y'.repeat(1500) } });
    await duCommand(h.io);
    expect(h.out()).toBe('2\t/a\n2\t/b\n4\ttotal\n');
  });

  test('--max-depth=0 prints only the argument', async () => {
    const h = makeIO({ args: ['du', '-b', '--max-depth=0', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('3072\t/d\n');
  });

  test('-d 1 prints one level of subdirectories', async () => {
    const h = makeIO({ args: ['du', '-b', '-d', '1', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('1024\t/d/sub\n3072\t/d\n');
  });

  test('-0 ends each record with NUL', async () => {
    const h = makeIO({ args: ['du', '-b', '-0', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('1024\t/d/sub\x003072\t/d\x00');
  });

  test('-a with --max-depth limits printed depth but still counts descendants', async () => {
    const h = makeIO({ args: ['du', '-b', '-a', '-d', '1', '/d'], files: tree });
    await duCommand(h.io);
    // /d/a (depth 1) prints; /d/sub/b (depth 2) does not; /d/sub and /d print.
    expect(h.out()).toBe('2048\t/d/a\n1024\t/d/sub\n3072\t/d\n');
  });

  test('unknown flag → exit 1 diagnostic', async () => {
    const h = makeIO({ args: ['du', '--bogus', '/d'], files: tree });
    expect(await duCommand(h.io)).toBe(1);
    expect(h.err()).toContain('unrecognized option \'--bogus\'');
  });
});

import { expect, test, describe } from 'vitest';
import { sumCommand } from './sum.ts';
import { bsdSum } from './cksum.ts';
import { makeIO } from './_test-io.ts';

describe('sum (BSD checksum + block count)', () => {
  test('bsdSum computes the rotating 16-bit checksum', () => {
    expect(bsdSum(new TextEncoder().encode('hello\n'))).toEqual({ checksum: 36979, blocks: 1 });
    expect(bsdSum(new TextEncoder().encode('abc'))).toEqual({ checksum: 16556, blocks: 1 });
  });

  test('blocks are counted in 1024-byte units (GNU BSD sum)', () => {
    expect(bsdSum(new Uint8Array(1025)).blocks).toBe(2);
    expect(bsdSum(new Uint8Array(1024)).blocks).toBe(1);
    expect(bsdSum(new Uint8Array(512)).blocks).toBe(1);
    expect(bsdSum(new Uint8Array(0)).blocks).toBe(0);
  });

  test('prints checksum and block count for stdin', async () => {
    const h = makeIO({ args: ['sum'], stdinText: 'hello\n' });
    expect(await sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('36979     1\n');
  });

  test('prints the filename for a file operand', async () => {
    const h = makeIO({ args: ['sum', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    expect(await sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('36979     1 /f.txt\n');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['sum', '/missing'] });
    expect(await sumCommand(h.io)).toBe(1);
    expect(h.err()).toContain('sum:');
  });

  // ── GNU parity: zero-padded BSD checksum, 1024-byte blocks, -s (System V) ──

  test('the BSD checksum is zero-padded to 5 digits', async () => {
    // "hello world\n" → BSD checksum 3762 → "03762", 12 bytes → 1 (1024-byte) block.
    const h = makeIO({ args: ['sum', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    expect(await sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('03762     1 /f.txt\n');
  });

  test('BSD block counts use 1024-byte units', async () => {
    const h = makeIO({ args: ['sum', '/big'], files: { '/big': 'x'.repeat(1000) } });
    await sumCommand(h.io);
    expect(h.out()).toBe('38126     1 /big\n'); // 1000 bytes → 1 block (not 2)
  });

  test('-r is the explicit BSD algorithm (same as default)', async () => {
    const h = makeIO({ args: ['sum', '-r', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await sumCommand(h.io);
    expect(h.out()).toBe('03762     1 /f.txt\n');
  });

  test('-s is the System V algorithm (%d %d name, 512-byte blocks)', async () => {
    const h = makeIO({ args: ['sum', '-s', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    expect(await sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1126 1 /f.txt\n');
  });

  test('--sysv is an alias for -s', async () => {
    const h = makeIO({ args: ['sum', '--sysv', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await sumCommand(h.io);
    expect(h.out()).toBe('1126 1 /f.txt\n');
  });

  test('-s counts blocks in 512-byte units', async () => {
    const h = makeIO({ args: ['sum', '-s', '/b'], files: { '/b': 'y'.repeat(1025) } });
    await sumCommand(h.io);
    expect(h.out()).toBe('58490 3 /b\n'); // 1025 bytes → 3 (512-byte) blocks
  });

  test('-s over stdin has no filename', async () => {
    const h = makeIO({ args: ['sum', '-s'], stdinText: 'hello world\n' });
    await sumCommand(h.io);
    expect(h.out()).toBe('1126 1\n');
  });
});

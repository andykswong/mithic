import { expect, test, describe } from 'vitest';
import { md5sumCommand } from './md5sum.ts';
import { md5hex } from './_md5.ts';
import { makeIO } from './_testio.ts';

// Canonical MD5 vectors (RFC 1321 appendix A.5 + the well-known "abc"):
//   ""    → d41d8cd98f00b204e9800998ecf8427e
//   "abc" → 900150983cd24fb0d6963f7d28e17f72
//   "message digest" → f96b697d7cb7938d525a2f31aaf161d0
describe('md5 digest (_md5.ts)', () => {
  const enc = new TextEncoder();
  test('reproduces the canonical RFC 1321 vectors', () => {
    expect(md5hex(enc.encode(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5hex(enc.encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5hex(enc.encode('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    // Further RFC 1321 A.5 vectors covering multi-block padding.
    expect(md5hex(enc.encode('abcdefghijklmnopqrstuvwxyz'))).toBe('c3fcd3d76192e4007dfb496cca67e13b');
    expect(
      md5hex(enc.encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')),
    ).toBe('d174ab98d277d9f5a5611c2c9f419d9f');
    expect(
      md5hex(enc.encode('12345678901234567890123456789012345678901234567890123456789012345678901234567890')),
    ).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
});

describe('md5sum', () => {
  test('hashes stdin (empty + abc + message digest vectors)', async () => {
    const h1 = makeIO({ args: ['md5sum'], stdinText: '' });
    await md5sumCommand(h1.io);
    expect(h1.out()).toBe('d41d8cd98f00b204e9800998ecf8427e  -\n');

    const h2 = makeIO({ args: ['md5sum'], stdinText: 'abc' });
    await md5sumCommand(h2.io);
    expect(h2.out()).toBe('900150983cd24fb0d6963f7d28e17f72  -\n');

    const h3 = makeIO({ args: ['md5sum'], stdinText: 'message digest' });
    await md5sumCommand(h3.io);
    expect(h3.out()).toBe('f96b697d7cb7938d525a2f31aaf161d0  -\n');
  });

  test('hashes a file with GNU two-space format', async () => {
    const h = makeIO({ args: ['md5sum', '/f.txt'], files: { '/f.txt': 'abc' } });
    expect(await md5sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('900150983cd24fb0d6963f7d28e17f72  /f.txt\n');
  });

  test('-c verifies (OK + FAILED, exit 1 on mismatch)', async () => {
    const h = makeIO({
      args: ['md5sum', '-c', '/sums'],
      files: {
        '/sums': '900150983cd24fb0d6963f7d28e17f72  /a\nffffffffffffffffffffffffffffffff  /b\n',
        '/a': 'abc', '/b': 'xyz',
      },
    });
    expect(await md5sumCommand(h.io)).toBe(1);
    expect(h.out()).toContain('/a: OK');
    expect(h.out()).toContain('/b: FAILED');
  });

  // ── GNU parity: --tag / -b / -z ──

  test('--tag prints the BSD reversed form', async () => {
    const h = makeIO({ args: ['md5sum', '--tag', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    expect(await md5sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('MD5 (/f.txt) = 6f5902ac237024bdd0c176cb93063dc4\n');
  });

  test('--tag over stdin names the source `-`', async () => {
    const h = makeIO({ args: ['md5sum', '--tag'], stdinText: 'hello world\n' });
    await md5sumCommand(h.io);
    expect(h.out()).toBe('MD5 (-) = 6f5902ac237024bdd0c176cb93063dc4\n');
  });

  test('-b marks the name with an asterisk (binary mode)', async () => {
    const h = makeIO({ args: ['md5sum', '-b', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await md5sumCommand(h.io);
    expect(h.out()).toBe('6f5902ac237024bdd0c176cb93063dc4 */f.txt\n');
  });

  test('-z terminates the line with NUL instead of newline', async () => {
    const h = makeIO({ args: ['md5sum', '-z', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await md5sumCommand(h.io);
    expect(h.out()).toBe('6f5902ac237024bdd0c176cb93063dc4  /f.txt\0');
  });

  test('-b -z keeps the asterisk and NUL-terminates', async () => {
    const h = makeIO({ args: ['md5sum', '-b', '-z', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await md5sumCommand(h.io);
    expect(h.out()).toBe('6f5902ac237024bdd0c176cb93063dc4 */f.txt\0');
  });

  // ── GNU parity: verify-only options error without -c ──

  test('--status without -c errors and exits 1', async () => {
    const h = makeIO({ args: ['md5sum', '--status', '/f.txt'], files: { '/f.txt': 'x' } });
    expect(await md5sumCommand(h.io)).toBe(1);
    expect(h.err()).toBe('md5sum: the --status option is meaningful only when verifying checksums\nTry \'md5sum --help\' for more information.\n');
  });

  test('--quiet without -c errors and exits 1', async () => {
    const h = makeIO({ args: ['md5sum', '--quiet', '/f.txt'], files: { '/f.txt': 'x' } });
    expect(await md5sumCommand(h.io)).toBe(1);
    expect(h.err()).toContain('the --quiet option is meaningful only when verifying checksums');
  });

  test('--ignore-missing without -c errors and exits 1', async () => {
    const h = makeIO({ args: ['md5sum', '--ignore-missing', '/f.txt'], files: { '/f.txt': 'x' } });
    expect(await md5sumCommand(h.io)).toBe(1);
    expect(h.err()).toContain('the --ignore-missing option is meaningful only when verifying checksums');
  });

  // ── GNU parity: -c summaries, --status, --quiet ──

  test('-c prints the WARNING summary on a mismatch', async () => {
    const h = makeIO({
      args: ['md5sum', '-c', '/sums'],
      files: { '/sums': 'ffffffffffffffffffffffffffffffff  /a\n', '/a': 'abc' },
    });
    expect(await md5sumCommand(h.io)).toBe(1);
    expect(h.out()).toBe('/a: FAILED\n');
    expect(h.err()).toBe('md5sum: WARNING: 1 computed checksum did NOT match\n');
  });

  test('-c --status is silent, exit reflects the mismatch', async () => {
    const h = makeIO({
      args: ['md5sum', '-c', '--status', '/sums'],
      files: { '/sums': 'ffffffffffffffffffffffffffffffff  /a\n', '/a': 'abc' },
    });
    expect(await md5sumCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toBe('');
  });

  test('-c --quiet suppresses OK lines (keeps FAILED + warning)', async () => {
    const h = makeIO({
      args: ['md5sum', '-c', '--quiet', '/sums'],
      files: {
        '/sums': '900150983cd24fb0d6963f7d28e17f72  /a\nffffffffffffffffffffffffffffffff  /b\n',
        '/a': 'abc', '/b': 'xyz',
      },
    });
    expect(await md5sumCommand(h.io)).toBe(1);
    expect(h.out()).toBe('/b: FAILED\n');
  });

  test('-c --ignore-missing skips a missing listed file', async () => {
    const h = makeIO({
      args: ['md5sum', '-c', '--ignore-missing', '/sums'],
      files: { '/sums': '900150983cd24fb0d6963f7d28e17f72  /a\nffffffffffffffffffffffffffffffff  /gone\n', '/a': 'abc' },
    });
    expect(await md5sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a: OK\n');
  });

  test('-c with all-malformed lines reports no formatted lines and exits 1', async () => {
    const h = makeIO({ args: ['md5sum', '-c', '/sums'], files: { '/sums': 'garbage\nmore garbage\n' } });
    expect(await md5sumCommand(h.io)).toBe(1);
    expect(h.err()).toBe('md5sum: /sums: no properly formatted checksum lines found\n');
  });
});

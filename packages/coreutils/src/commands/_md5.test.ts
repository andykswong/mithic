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
});

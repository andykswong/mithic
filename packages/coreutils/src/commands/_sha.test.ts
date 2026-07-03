import { expect, test, describe } from 'vitest';
import { sha1sumCommand } from './sha1sum.ts';
import { sha256sumCommand } from './sha256sum.ts';
import { sha512sumCommand } from './sha512sum.ts';
import { makeIO } from './_testio.ts';

// Well-known NIST "abc" digests (FIPS 180-4 examples) — verifiable, not
// self-referential.
const ABC = {
  sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  sha512:
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
    '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
};

describe('sha256sum', () => {
  test('stdin "abc" → known digest + "  -" (GNU two-space format)', async () => {
    const h = makeIO({ args: ['sha256sum'], stdinText: 'abc' });
    expect(await sha256sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe(`${ABC.sha256}  -\n`);
  });

  test('file operand prints "<hex>  <name>"', async () => {
    const h = makeIO({ args: ['sha256sum', '/f'], files: { '/f': 'abc' } });
    await sha256sumCommand(h.io);
    expect(h.out()).toBe(`${ABC.sha256}  /f\n`);
  });

  test('-c verifies a checksum file: OK + FAILED, exit 1 on mismatch', async () => {
    const h = makeIO({
      args: ['sha256sum', '-c', '/sums'],
      files: {
        '/good': 'abc',
        '/bad': 'xyz',
        '/sums': `${ABC.sha256}  /good\n${ABC.sha256}  /bad\n`,
      },
    });
    expect(await sha256sumCommand(h.io)).toBe(1);
    expect(h.out()).toBe('/good: OK\n/bad: FAILED\n');
  });

  test('-c all-OK exits 0', async () => {
    const h = makeIO({
      args: ['sha256sum', '-c', '/sums'],
      files: { '/good': 'abc', '/sums': `${ABC.sha256}  /good\n` },
    });
    expect(await sha256sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/good: OK\n');
  });

  // ── GNU parity: --tag / -b / -z, verify-only-option errors, wrong-length line ──

  test('--tag prints "SHA256 (name) = hex"', async () => {
    const h = makeIO({ args: ['sha256sum', '--tag', '/f'], files: { '/f': 'abc' } });
    await sha256sumCommand(h.io);
    expect(h.out()).toBe(`SHA256 (/f) = ${ABC.sha256}\n`);
  });

  test('-b marks the name with an asterisk', async () => {
    const h = makeIO({ args: ['sha256sum', '-b', '/f'], files: { '/f': 'abc' } });
    await sha256sumCommand(h.io);
    expect(h.out()).toBe(`${ABC.sha256} */f\n`);
  });

  test('-z NUL-terminates the line', async () => {
    const h = makeIO({ args: ['sha256sum', '-z', '/f'], files: { '/f': 'abc' } });
    await sha256sumCommand(h.io);
    expect(h.out()).toBe(`${ABC.sha256}  /f\0`);
  });

  test('--status without -c errors', async () => {
    const h = makeIO({ args: ['sha256sum', '--status', '/f'], files: { '/f': 'abc' } });
    expect(await sha256sumCommand(h.io)).toBe(1);
    expect(h.err()).toContain('the --status option is meaningful only when verifying checksums');
  });

  test('-c rejects a wrong-length (non-SHA256) hex line as unformatted', async () => {
    // A 32-char (MD5-length) hex is not a valid SHA256 line → "no properly formatted".
    const h = makeIO({
      args: ['sha256sum', '-c', '/sums'],
      files: { '/f': 'abc', '/sums': '6f5902ac237024bdd0c176cb93063dc4  /f\n' },
    });
    expect(await sha256sumCommand(h.io)).toBe(1);
    expect(h.err()).toBe('sha256sum: /sums: no properly formatted checksum lines found\n');
  });

  test('-c --status is silent on mismatch', async () => {
    const h = makeIO({
      args: ['sha256sum', '-c', '--status', '/sums'],
      files: { '/bad': 'xyz', '/sums': `${ABC.sha256}  /bad\n` },
    });
    expect(await sha256sumCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toBe('');
  });

  test('--tag label matches each algorithm (SHA1)', async () => {
    const h = makeIO({ args: ['sha1sum', '--tag', '/f'], files: { '/f': 'abc' } });
    await sha1sumCommand(h.io);
    expect(h.out()).toBe(`SHA1 (/f) = ${ABC.sha1}\n`);
  });
});

describe('sha1sum', () => {
  test('stdin "abc" → known SHA-1 digest', async () => {
    const h = makeIO({ args: ['sha1sum'], stdinText: 'abc' });
    await sha1sumCommand(h.io);
    expect(h.out()).toBe(`${ABC.sha1}  -\n`);
  });
});

describe('sha512sum', () => {
  test('stdin "abc" → known SHA-512 digest', async () => {
    const h = makeIO({ args: ['sha512sum'], stdinText: 'abc' });
    await sha512sumCommand(h.io);
    expect(h.out()).toBe(`${ABC.sha512}  -\n`);
  });
});

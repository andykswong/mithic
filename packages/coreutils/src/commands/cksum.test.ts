import { expect, test, describe } from 'vitest';
import { cksumCommand } from './cksum.ts';
import { sumCommand } from './cksum.ts';
import { crc32, bsdSum, posixCksum } from './cksum.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: { args: string[]; stdinText?: string; files?: Record<string, string> }) {
  const files = opts.files ?? {};
  const enc = new TextEncoder();
  const stdinBytes = enc.encode(opts.stdinText ?? '');
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(stdinBytes); c.close(); } });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });
  const open = new Map<number, { bytes: Uint8Array; offset: number }>();
  let nextFd = 3;
  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    if (call === 'fs/open') {
      const path = String(args.path);
      if (!(path in files)) throw Object.assign(new Error('No such file or directory'), { errno: 'ENOENT' });
      const fd = nextFd++;
      open.set(fd, { bytes: enc.encode(files[path]), offset: 0 });
      return { fd };
    }
    if (call === 'fs/read') {
      const e = open.get(Number(args.fd))!;
      const len = Number(args.len ?? 0);
      const slice = e.bytes.subarray(e.offset, e.offset + len);
      e.offset += slice.byteLength;
      return slice;
    }
    if (call === 'fs/close') { open.delete(Number(args.fd)); return {}; }
    throw new Error(`unexpected syscall ${call}`);
  };
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  return {
    io: { args: opts.args, env: {}, cwd: '/', stdin, stdout, stderr, syscall } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
  };
}

describe('crc32', () => {
  test('empty input', () => {
    // CRC32 of empty data
    expect(crc32(new Uint8Array())).toBe(0);
  });
  test('known value for "abc"', () => {
    // CRC32 of 'abc' = 0x352441C2
    expect(crc32(new TextEncoder().encode('abc'))).toBe(0x352441c2);
  });
  test('deterministic', () => {
    const d = new TextEncoder().encode('hello world');
    expect(crc32(d)).toBe(crc32(d));
  });
});

describe('posixCksum (cksum-command algorithm)', () => {
  // Canonical GNU/BSD `cksum` values (verified against the real utility).
  test('empty input → 4294967295', () => {
    expect(posixCksum(new Uint8Array())).toBe(4294967295);
  });
  test('"a\\n" → 2418082923, length 2', () => {
    expect(posixCksum(new TextEncoder().encode('a\n'))).toBe(2418082923);
  });
  test('"hello\\n" matches the real cksum value', () => {
    // `printf 'hello\n' | cksum` → 3015617425 6
    expect(posixCksum(new TextEncoder().encode('hello\n'))).toBe(3015617425);
  });
  test('differs from the reflected zlib crc32', () => {
    const d = new TextEncoder().encode('abc');
    expect(posixCksum(d)).not.toBe(crc32(d));
  });
});

describe('bsdSum', () => {
  test('empty input', () => {
    const { checksum, blocks } = bsdSum(new Uint8Array());
    expect(checksum).toBe(0);
    expect(blocks).toBe(0);
  });
  test('single byte', () => {
    const { checksum } = bsdSum(new Uint8Array([65])); // 'A'
    expect(checksum).toBeGreaterThanOrEqual(0);
    expect(checksum).toBeLessThanOrEqual(65535);
  });
  test('block count (GNU sum uses 1024-byte blocks for the BSD algorithm)', () => {
    expect(bsdSum(new Uint8Array(1024)).blocks).toBe(1);
    expect(bsdSum(new Uint8Array(1025)).blocks).toBe(2);
    expect(bsdSum(new Uint8Array(512)).blocks).toBe(1);
    expect(bsdSum(new Uint8Array(0)).blocks).toBe(0);
  });
});

describe('cksum command', () => {
  test('cksum stdin outputs CRC length', async () => {
    const h = makeIO({ args: ['cksum'], stdinText: 'hello\n' });
    const code = await cksumCommand(h.io);
    expect(code).toBe(0);
    const parts = h.out().trim().split(' ');
    expect(parts.length).toBe(2);
    expect(Number(parts[0])).toBeGreaterThan(0);
    expect(parts[1]).toBe('6'); // "hello\n" is 6 bytes
  });

  test('cksum file outputs filename', async () => {
    const h = makeIO({
      args: ['cksum', '/f.txt'],
      files: { '/f.txt': 'abc\n' },
    });
    await cksumCommand(h.io);
    expect(h.out()).toContain('/f.txt');
  });

  test('cksum missing file exits 1', async () => {
    const h = makeIO({ args: ['cksum', '/missing.txt'] });
    expect(await cksumCommand(h.io)).toBe(1);
    expect(h.err()).toContain('missing.txt');
  });

  // ── GNU-9 -a/--algorithm interface ──

  test('-a crc is the POSIX cksum CRC (default)', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'crc', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3733384285 12 /f.txt\n');
  });

  test('-a crc32b is the reflected zlib CRC-32', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'crc32b', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await cksumCommand(h.io);
    expect(h.out()).toBe('2936552237 12 /f.txt\n');
  });

  test('-a sha256 prints the BSD-tag form by default', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'sha256', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('SHA256 (/f.txt) = a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447\n');
  });

  test('-a md5 tag form', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'md5', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await cksumCommand(h.io);
    expect(h.out()).toBe('MD5 (/f.txt) = 6f5902ac237024bdd0c176cb93063dc4\n');
  });

  test('-a sha224 uses the pure-TS SHA-224 (Web Crypto has none)', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'sha224', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('SHA224 (/f.txt) = 95041dd60ab08c0bf5636d50be85fe9790300f39eb84602858a9b430\n');
  });

  test('--untagged -a sha224 prints the GNU sum form', async () => {
    const h = makeIO({ args: ['cksum', '--untagged', '-a', 'sha224'], stdinText: 'hello world\n' });
    await cksumCommand(h.io);
    expect(h.out()).toBe('95041dd60ab08c0bf5636d50be85fe9790300f39eb84602858a9b430  -\n');
  });

  test('--untagged -a sha256 prints the GNU sum form', async () => {
    const h = makeIO({ args: ['cksum', '--untagged', '-a', 'sha256', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await cksumCommand(h.io);
    expect(h.out()).toBe('a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447  /f.txt\n');
  });

  test('-a sha256 over stdin names the source `-`', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'sha256'], stdinText: 'hello world\n' });
    await cksumCommand(h.io);
    expect(h.out()).toBe('SHA256 (-) = a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447\n');
  });

  test('-a bsd reuses the BSD sum format', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'bsd', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await cksumCommand(h.io);
    expect(h.out()).toBe('03762     1 /f.txt\n');
  });

  test('-a sysv reuses the System V sum format', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'sysv', '/f.txt'], files: { '/f.txt': 'hello world\n' } });
    await cksumCommand(h.io);
    expect(h.out()).toBe('1126 1 /f.txt\n');
  });

  test('an invalid -a argument lists the valid ones and exits 1', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'bogus', '/f.txt'], files: { '/f.txt': 'x' } });
    expect(await cksumCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid argument ‘bogus’ for ‘--algorithm’');
    expect(h.err()).toContain('- ‘sha256’');
  });

  // ── M9: -z / --zero uses a NUL line terminator ──

  test('-z ends the default CRC line with NUL instead of newline', async () => {
    const h = makeIO({ args: ['cksum', '-z', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3015617425 6 /f.txt\x00');
  });

  test('--zero ends the tagged hash line with NUL', async () => {
    const h = makeIO({ args: ['cksum', '--zero', '-a', 'md5', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    await cksumCommand(h.io);
    expect(h.out()).toBe('MD5 (/f.txt) = b1946ac92492d2347c6235b4d2611184\x00');
  });

  test('-z with --untagged and multiple files puts NUL after each line', async () => {
    const h = makeIO({ args: ['cksum', '-z', '--untagged', '-a', 'sha256', '/a', '/b'], files: { '/a': 'x', '/b': 'y' } });
    await cksumCommand(h.io);
    const parts = h.out().split('\x00');
    expect(parts.length).toBe(3); // two lines each NUL-terminated + trailing empty
    expect(parts[0].endsWith('  /a')).toBe(true);
    expect(parts[1].endsWith('  /b')).toBe(true);
    expect(parts[2]).toBe('');
    expect(h.out()).not.toContain('\n');
  });

  // ── L13: BLAKE2b and SM3 digests (pure-TS) ──

  test('-a blake2b produces the GNU 512-bit tagged digest', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'blake2b', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toBe(
      'BLAKE2b (/f.txt) = f60ce482e5cc1229f39d71313171a8d9f4ca3a87d066bf4b205effb528192a75' +
      'f14f3271e2c1a90e1de53f275b4d4793eef2f5e31ea90d2ce29d2e481c36435f\n',
    );
  });

  test('-a blake2b --length=256 selects the BLAKE2b-256 tag and digest', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'blake2b', '--length=256', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('BLAKE2b-256 (/f.txt) = 93becc6e9882211c3ec3708c95bcd69baab7bb59c7f4bc84ce637b88a534b783\n');
  });

  test('-a sm3 produces the GNU tagged digest', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'sm3', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('SM3 (/f.txt) = f7a87a195b0cc0052b9d598482212ceb07e4ea60e8d139a5dfeff36c24abf2b3\n');
  });

  test('-a sm3 empty input matches the SM3 spec value', async () => {
    // SM3("") per GNU gcksum -a sm3.
    const h = makeIO({ args: ['cksum', '--untagged', '-a', 'sm3'], stdinText: '' });
    await cksumCommand(h.io);
    expect(h.out()).toBe('1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b  -\n');
  });

  // ── D6: --length is only valid for blake2b (GNU rejects it elsewhere) ──

  test.each(['md5', 'sha256', 'crc', 'bsd', 'sm3', 'sysv'])(
    '--length with -a %s is rejected (exit 1, GNU diagnostic)',
    async (algo) => {
      const h = makeIO({ args: ['cksum', '-a', algo, '--length=256', '/f.txt'], files: { '/f.txt': 'hello\n' } });
      expect(await cksumCommand(h.io)).toBe(1);
      expect(h.err()).toBe('cksum: --length is only supported with --algorithm blake2b, sha2, or sha3\n');
      expect(h.out()).toBe('');
    },
  );

  test('bare cksum --length is rejected (default algorithm is crc)', async () => {
    const h = makeIO({ args: ['cksum', '--length=256', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    expect(await cksumCommand(h.io)).toBe(1);
    expect(h.err()).toBe('cksum: --length is only supported with --algorithm blake2b, sha2, or sha3\n');
    expect(h.out()).toBe('');
  });

  test('-a blake2b --length still produces its digest (exit 0)', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'blake2b', '--length=256', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('BLAKE2b-256 (/f.txt) = 93becc6e9882211c3ec3708c95bcd69baab7bb59c7f4bc84ce637b88a534b783\n');
  });

  // ── C1: --length must reject trailing non-digit garbage (GNU strtol-strict) ──

  test.each(['256x', '0x100', '8bad'])(
    '-a blake2b --length=%s is rejected (trailing garbage, exit 1)',
    async (len) => {
      const h = makeIO({ args: ['cksum', '-a', 'blake2b', `--length=${len}`, '/f.txt'], files: { '/f.txt': 'hi' } });
      expect(await cksumCommand(h.io)).toBe(1);
      expect(h.err()).toBe(`cksum: invalid length: ‘${len}’\n`);
      expect(h.out()).toBe('');
    },
  );

  test('-a blake2b --length out-of-range emits the GNU two-line diagnostic', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'blake2b', '--length=520', '/f.txt'], files: { '/f.txt': 'hi' } });
    expect(await cksumCommand(h.io)).toBe(1);
    expect(h.err()).toBe('cksum: invalid length: ‘520’\ncksum: maximum digest length for ‘BLAKE2b’ is 512 bits\n');
    expect(h.out()).toBe('');
  });

  test('-a blake2b --length not a multiple of 8 emits the GNU two-line diagnostic', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'blake2b', '--length=12', '/f.txt'], files: { '/f.txt': 'hi' } });
    expect(await cksumCommand(h.io)).toBe(1);
    expect(h.err()).toBe('cksum: invalid length: ‘12’\ncksum: length is not a multiple of 8\n');
    expect(h.out()).toBe('');
  });

  // ── C-WS: --length accepts xstrtol leading whitespace / leading + (GNU parity) ──

  test.each([' 8', '+8'])(
    '-a blake2b --length=%j accepts leading ws / + (BLAKE2b-8, exit 0)',
    async (len) => {
      const h = makeIO({ args: ['cksum', '-a', 'blake2b', `--length=${len}`], stdinText: 'abc' });
      expect(await cksumCommand(h.io)).toBe(0);
      expect(h.out()).toBe('BLAKE2b-8 (-) = 6b\n');
    },
  );

  test.each(['256x', '8bad', '8 '])(
    '-a blake2b --length=%j still rejected (trailing garbage, exit 1)',
    async (len) => {
      const h = makeIO({ args: ['cksum', '-a', 'blake2b', `--length=${len}`], stdinText: 'abc' });
      expect(await cksumCommand(h.io)).toBe(1);
      expect(h.err()).toBe(`cksum: invalid length: ‘${len}’\n`);
      expect(h.out()).toBe('');
    },
  );

  test('-a blake2b --length=0 keeps the default 512-bit digest (exit 0)', async () => {
    const h = makeIO({ args: ['cksum', '-a', 'blake2b', '--length=0', '/f.txt'], files: { '/f.txt': 'hi' } });
    expect(await cksumCommand(h.io)).toBe(0);
    expect(h.out()).toMatch(/^BLAKE2b \(\/f\.txt\) = [0-9a-f]{128}\n$/);
  });
});

describe('sum command', () => {
  test('sum stdin outputs checksum and block count', async () => {
    const h = makeIO({ args: ['sum'], stdinText: 'hello\n' });
    const code = await sumCommand(h.io);
    expect(code).toBe(0);
    const line = h.out().trim();
    // Format: "NNNNN     N" (padded)
    expect(line.length).toBeGreaterThan(0);
    const parts = line.trim().split(/\s+/);
    expect(parts.length).toBe(2);
  });

  test('sum file shows filename', async () => {
    const h = makeIO({
      args: ['sum', '/f.txt'],
      files: { '/f.txt': 'data\n' },
    });
    await sumCommand(h.io);
    expect(h.out()).toContain('/f.txt');
  });
});

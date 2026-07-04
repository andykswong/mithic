import { expect, test, describe } from 'vitest';
import { base32Command } from './base32.ts';
import { b32Encode, b32Decode } from './base32.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: { args: string[]; stdinText?: string; stdinBytes?: Uint8Array; files?: Record<string, string | Uint8Array> }) {
  const enc = new TextEncoder();
  const bytes = opts.stdinBytes ?? enc.encode(opts.stdinText ?? '');
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  const concat = (chunks: Uint8Array[]): Uint8Array => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return b;
  };
  const files = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(opts.files ?? {})) {
    files.set(p.startsWith('/') ? p : '/' + p, typeof c === 'string' ? enc.encode(c) : c);
  }
  const fds = new Map<number, { data: Uint8Array; off: number }>();
  let nextFd = 3;
  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    if (call === 'fs/open') {
      const path = String(args.path);
      const data = files.get(path.startsWith('/') ? path : '/' + path);
      if (data === undefined) throw Object.assign(new Error('no-entry'), { code: 'ENOENT' });
      const fd = nextFd++; fds.set(fd, { data, off: 0 }); return { fd };
    }
    if (call === 'fs/read') {
      const e = fds.get(Number(args.fd))!;
      const slice = e.data.subarray(e.off, e.off + Number(args.len ?? 65536));
      e.off += slice.byteLength; return new Uint8Array(slice);
    }
    if (call === 'fs/close') { fds.delete(Number(args.fd)); return {}; }
    return {};
  };
  return {
    io: { args: opts.args, env: {}, cwd: '/', stdin, stdout, stderr, syscall } as CommandIO,
    outText: () => decode(outChunks),
    out: () => concat(outChunks),
    err: () => decode(errChunks),
  };
}

describe('b32Encode / b32Decode roundtrip', () => {
  test('empty', () => {
    expect(b32Encode(new Uint8Array(), 76)).toBe('');
    expect(b32Decode('')).toEqual(new Uint8Array());
  });

  test('single byte "f" → MY======', () => {
    expect(b32Encode(new TextEncoder().encode('f'), 0)).toBe('MY======');
    expect(new TextDecoder().decode(b32Decode('MY======')!)).toBe('f');
  });

  test('"fo" → MZXQ====', () => {
    expect(b32Encode(new TextEncoder().encode('fo'), 0)).toBe('MZXQ====');
    expect(new TextDecoder().decode(b32Decode('MZXQ====')!)).toBe('fo');
  });

  test('"foo" → MZXW6===', () => {
    expect(b32Encode(new TextEncoder().encode('foo'), 0)).toBe('MZXW6===');
    expect(new TextDecoder().decode(b32Decode('MZXW6===')!)).toBe('foo');
  });

  test('"foob" → MZXW6YQ=', () => {
    expect(b32Encode(new TextEncoder().encode('foob'), 0)).toBe('MZXW6YQ=');
    expect(new TextDecoder().decode(b32Decode('MZXW6YQ=')!)).toBe('foob');
  });

  test('"foobar" → MZXW6YTBOI======', () => {
    expect(b32Encode(new TextEncoder().encode('foobar'), 0)).toBe('MZXW6YTBOI======');
    expect(new TextDecoder().decode(b32Decode('MZXW6YTBOI======')!)).toBe('foobar');
  });

  test('decode is case-insensitive', () => {
    expect(new TextDecoder().decode(b32Decode('mzxw6===')!)).toBe('foo');
  });

  // GNU accepts unpadded base32: legal terminal group lengths are 2/4/5/7 chars.
  test('unpadded 5-char group decodes 3 bytes', () => {
    expect(new TextDecoder().decode(b32Decode('MFRGG')!)).toBe('abc'); // == MFRGG===
  });

  test('unpadded 2-char group decodes 1 byte', () => {
    expect(new TextDecoder().decode(b32Decode('ME')!)).toBe('a'); // == ME=====? (ME with 6 pad)
  });

  test('unpadded 7-char group decodes 4 bytes', () => {
    expect(new TextDecoder().decode(b32Decode('MFRGGZA')!)).toBe('abcd');
  });

  test('impossible group lengths (1/3/6 chars) are invalid', () => {
    expect(b32Decode('M')).toBeNull();
    expect(b32Decode('MFR')).toBeNull();
    expect(b32Decode('MFRGGZ')).toBeNull();
  });

  test('wrong explicit padding count is invalid', () => {
    expect(b32Decode('MY=')).toBeNull();    // 2 data need 6 pads
    expect(b32Decode('MZXW6==')).toBeNull(); // 5 data need 3 pads
  });

  // R2: after a FULLY PADDED terminal octet GNU resets and keeps decoding, so
  // concatenated padded octets and a padded octet followed by full octets decode
  // fully. An impossible-length tail after a padded octet still fails.
  test('concatenated fully-padded octets decode fully', () => {
    expect(new TextDecoder().decode(b32Decode('IE======IE======')!)).toBe('AA');
    expect(new TextDecoder().decode(b32Decode('MZXW6===MZXW6===')!)).toBe('foofoo');
  });

  test('a full octet after a padded terminal octet decodes (reset)', () => {
    // MFRA==== → "ab", then AAAAAAAA (all-zero full octet) → 5 zero bytes.
    expect(b32Decode('MFRA====AAAAAAAA')).toEqual(new Uint8Array([0x61, 0x62, 0, 0, 0, 0, 0]));
    // MFRA==== → "ab", then MFRGG (5-char terminal) → "abc" ⇒ "ababc" (a,b,a,b,c).
    expect(b32Decode('MFRA====MFRGG')).toEqual(new Uint8Array([0x61, 0x62, 0x61, 0x62, 0x63]));
  });

  test('an impossible-length tail after a padded octet fails', () => {
    // MFRA==== → "ab", then a lone "M" (1-char impossible octet) → fail.
    expect(b32Decode('MFRA====M')).toBeNull();
  });
});

describe('base32 command', () => {
  test('encodes stdin', async () => {
    const h = makeIO({ args: ['base32'], stdinText: 'foo' });
    expect(await base32Command(h.io)).toBe(0);
    expect(h.outText()).toBe('MZXW6===\n');
  });

  test('-d decodes', async () => {
    const h = makeIO({ args: ['base32', '-d'], stdinText: 'MZXW6===\n' });
    expect(await base32Command(h.io)).toBe(0);
    expect(new TextDecoder().decode(h.out())).toBe('foo');
  });

  test('-d invalid input exits 1', async () => {
    const h = makeIO({ args: ['base32', '-d'], stdinText: 'not-valid-base32-!!!' });
    expect(await base32Command(h.io)).toBe(1);
    expect(h.err()).toContain('invalid');
  });

  test('-w 0 no wrap', async () => {
    const h = makeIO({ args: ['base32', '-w', '0'], stdinText: 'foobar' });
    await base32Command(h.io);
    expect(h.outText()).not.toContain('\n');
  });

  // ── GNU parity: FILE operand, extra-operand, missing-file, -i, bad option ──

  test('reads the FILE operand (not stdin) when given', async () => {
    const h = makeIO({ args: ['base32', 'f.txt'], files: { 'f.txt': 'hi\n' }, stdinText: 'DECOY' });
    expect(await base32Command(h.io)).toBe(0);
    expect(h.outText()).toBe('NBUQU===\n');
  });

  test('an extra operand errors and exits 1', async () => {
    const h = makeIO({ args: ['base32', 'a.txt', 'b.txt'], files: { 'a.txt': 'x', 'b.txt': 'y' } });
    expect(await base32Command(h.io)).toBe(1);
    expect(h.err()).toBe('base32: extra operand ‘b.txt’\nTry \'base32 --help\' for more information.\n');
  });

  test('a missing FILE errors and exits 1', async () => {
    const h = makeIO({ args: ['base32', 'nope.txt'], files: {} });
    expect(await base32Command(h.io)).toBe(1);
    expect(h.err()).toBe('base32: nope.txt: No such file or directory\n');
  });

  test('-d -i ignores non-alphabet garbage', async () => {
    const h = makeIO({ args: ['base32', '-d', '-i'], stdinText: 'NBSWY3DP\n!!!\n' });
    expect(await base32Command(h.io)).toBe(0);
    expect(new TextDecoder().decode(h.out())).toBe('hello');
  });

  test('an unknown short flag errors like GNU (exit 1)', async () => {
    const h = makeIO({ args: ['base32', '-Z'], stdinText: '' });
    expect(await base32Command(h.io)).toBe(1);
    expect(h.err()).toBe('base32: invalid option -- \'Z\'\nTry \'base32 --help\' for more information.\n');
  });

  // GNU parity: unpadded input decodes. Regression for the incomplete-fix finding.
  test('-d decodes unpadded input (5 chars → 3 bytes), exit 0', async () => {
    const h = makeIO({ args: ['base32', '-d'], stdinText: 'MFRGG' });
    expect(await base32Command(h.io)).toBe(0);
    expect(new TextDecoder().decode(h.out())).toBe('abc');
  });

  test('-d emits the decoded prefix then errors on an impossible tail', async () => {
    // 'MFRGGZDFM' → 'abcde' (full octet) then a lone leftover char → exit 1.
    const h = makeIO({ args: ['base32', '-d'], stdinText: 'MFRGGZDFM' });
    expect(await base32Command(h.io)).toBe(1);
    expect(new TextDecoder().decode(h.out())).toBe('abcde');
    expect(h.err()).toBe('base32: invalid input\n');
  });

  // R2: a full octet after a padded terminal octet decodes across the streaming
  // window boundary (mithic used to error here because the mod-8 window hid the
  // reset). GNU: 'MFRA====AAAAAAAA' → "ab\0\0\0\0\0", exit 0.
  test('-d decodes a full octet following a padded terminal octet (exit 0)', async () => {
    const h = makeIO({ args: ['base32', '-d'], stdinText: 'MFRA====AAAAAAAA' });
    expect(await base32Command(h.io)).toBe(0);
    expect(h.out()).toEqual(new Uint8Array([0x61, 0x62, 0, 0, 0, 0, 0]));
  });

  test('-d decodes concatenated padded octets (IE======IE====== → AA), exit 0', async () => {
    const h = makeIO({ args: ['base32', '-d'], stdinText: 'IE======IE======' });
    expect(await base32Command(h.io)).toBe(0);
    expect(new TextDecoder().decode(h.out())).toBe('AA');
  });

  test('-d errors on an impossible-length tail after a padded octet', async () => {
    const h = makeIO({ args: ['base32', '-d'], stdinText: 'MFRA====M' });
    expect(await base32Command(h.io)).toBe(1);
    expect(new TextDecoder().decode(h.out())).toBe('ab');
    expect(h.err()).toBe('base32: invalid input\n');
  });
});

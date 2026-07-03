import { expect, test, describe } from 'vitest';
import { base64Command } from './base64.ts';
import { b64Encode, b64Decode } from './base64.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: {
  args: string[];
  stdinBytes?: Uint8Array;
  stdinText?: string;
  files?: Record<string, string | Uint8Array>;
}): { io: CommandIO; out(): Uint8Array; outText(): string; err(): string } {
  const enc = new TextEncoder();
  const bytes = opts.stdinBytes ?? (opts.stdinText !== undefined ? enc.encode(opts.stdinText) : new Uint8Array());
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });
  const decode = (chunks: Uint8Array[]): string => {
    let total = 0; for (const c of chunks) total += c.byteLength;
    const buf = new Uint8Array(total); let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(buf);
  };
  const concat = (chunks: Uint8Array[]): Uint8Array => {
    let total = 0; for (const c of chunks) total += c.byteLength;
    const buf = new Uint8Array(total); let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return buf;
  };
  // A minimal fd-backed fs for FILE operands: `fs/open` opens a seeded file (or
  // throws ENOENT), `fs/read` streams it in 64 KiB chunks, `fs/close` frees the fd.
  const files = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(opts.files ?? {})) {
    files.set(p.startsWith('/') ? p : '/' + p, typeof c === 'string' ? enc.encode(c) : c);
  }
  const fds = new Map<number, { data: Uint8Array; off: number }>();
  let nextFd = 3;
  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    if (call === 'fs/open') {
      const path = String(args.path);
      const key = path.startsWith('/') ? path : '/' + path;
      const data = files.get(key);
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
    io: { args: opts.args, env: {}, cwd: '/', stdin, stdout, stderr, syscall },
    out: () => concat(outChunks),
    outText: () => decode(outChunks),
    err: () => decode(errChunks),
  };
}

describe('b64Encode / b64Decode roundtrip', () => {
  test('empty input', () => {
    expect(b64Encode(new Uint8Array(), 76)).toBe('');
    expect(b64Decode('')).toEqual(new Uint8Array());
  });

  test('single byte', () => {
    const enc = b64Encode(new Uint8Array([77]), 0);
    expect(enc).toBe('TQ==');
    expect(b64Decode('TQ==')).toEqual(new Uint8Array([77]));
  });

  test('two bytes', () => {
    const enc = b64Encode(new Uint8Array([77, 97]), 0);
    expect(enc).toBe('TWE=');
    expect(b64Decode('TWE=')).toEqual(new Uint8Array([77, 97]));
  });

  test('three bytes (no padding)', () => {
    const enc = b64Encode(new Uint8Array([77, 97, 110]), 0);
    expect(enc).toBe('TWFu');
    expect(b64Decode('TWFu')).toEqual(new Uint8Array([77, 97, 110]));
  });

  test('roundtrip longer string', () => {
    const original = new TextEncoder().encode('Hello, World!');
    const encoded = b64Encode(original, 0);
    expect(encoded).toBe('SGVsbG8sIFdvcmxkIQ==');
    expect(b64Decode(encoded)).toEqual(original);
  });

  test('wrap at 4 chars', () => {
    const enc = b64Encode(new TextEncoder().encode('Hello'), 4);
    expect(enc).toBe('SGVs\nbG8=\n');
  });

  test('wrap 0 = no wrap', () => {
    const enc = b64Encode(new TextEncoder().encode('Hello, World!'), 0);
    expect(enc).not.toContain('\n');
  });

  test('decode ignores whitespace', () => {
    const decoded = b64Decode('SGVs\nbG8=\n');
    expect(new TextDecoder().decode(decoded!)).toBe('Hello');
  });

  test('decode returns null on invalid input', () => {
    expect(b64Decode('!!!')).toBeNull();
  });

  // GNU accepts unpadded base64: a 2/3-char terminal group decodes 1/2 bytes.
  test('unpadded 2-char group decodes 1 byte', () => {
    expect(new TextDecoder().decode(b64Decode('YQ')!)).toBe('a'); // == 'YQ=='
  });

  test('unpadded 3-char group decodes 2 bytes', () => {
    expect(new TextDecoder().decode(b64Decode('aGk')!)).toBe('hi'); // == 'aGk='
  });

  test('unpadded 7-char input decodes 5 bytes', () => {
    expect(new TextDecoder().decode(b64Decode('aGVsbG8')!)).toBe('hello'); // == 'aGVsbG8='
  });

  test('a lone leftover char (len%4===1) is invalid', () => {
    expect(b64Decode('a')).toBeNull();
    expect(b64Decode('aGVsa')).toBeNull();
  });

  test('nonzero trailing bits are invalid but bytes still returned via group', () => {
    // 'aG' → 'h' but the low 4 bits of G are nonzero, so GNU errors.
    expect(b64Decode('aG')).toBeNull();
  });

  test('wrong explicit padding count is invalid', () => {
    expect(b64Decode('YQ=')).toBeNull();   // 2 data need 2 pads, not 1
    expect(b64Decode('aGk==')).toBeNull(); // 3 data need 1 pad, not 2
    expect(b64Decode('aGVsbG8=x')).toBeNull(); // data after a terminal group
  });
});

describe('base64 command', () => {
  test('encodes stdin with default wrap 76', async () => {
    const h = makeIO({ args: ['base64'], stdinText: 'hello' });
    const code = await base64Command(h.io);
    expect(code).toBe(0);
    expect(h.outText()).toBe('aGVsbG8=\n');
  });

  test('-w 0 produces no wrapping', async () => {
    const input = 'A'.repeat(60); // 80 base64 chars > 76
    const h = makeIO({ args: ['base64', '-w', '0'], stdinText: input });
    await base64Command(h.io);
    expect(h.outText()).not.toContain('\n');
  });

  test('-d decodes', async () => {
    const h = makeIO({ args: ['base64', '-d'], stdinText: 'aGVsbG8=\n' });
    const code = await base64Command(h.io);
    expect(code).toBe(0);
    expect(new TextDecoder().decode(h.out())).toBe('hello');
  });

  test('--decode is alias for -d', async () => {
    const h = makeIO({ args: ['base64', '--decode'], stdinText: 'aGVsbG8=' });
    expect(await base64Command(h.io)).toBe(0);
    expect(new TextDecoder().decode(h.out())).toBe('hello');
  });

  test('-d invalid input exits 1', async () => {
    const h = makeIO({ args: ['base64', '-d'], stdinText: '!!!invalid' });
    const code = await base64Command(h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('invalid');
  });

  // ── GNU parity: FILE operand, extra-operand, missing-file, -i, bad option ──

  test('reads the FILE operand (not stdin) when given', async () => {
    // stdin here is a decoy; GNU reads the file operand.
    const h = makeIO({ args: ['base64', 'f.txt'], files: { 'f.txt': 'hello world\n' }, stdinText: 'DECOY' });
    expect(await base64Command(h.io)).toBe(0);
    expect(h.outText()).toBe('aGVsbG8gd29ybGQK\n');
  });

  test('a lone - reads stdin', async () => {
    const h = makeIO({ args: ['base64', '-'], stdinText: 'hello' });
    expect(await base64Command(h.io)).toBe(0);
    expect(h.outText()).toBe('aGVsbG8=\n');
  });

  test('an extra operand errors and exits 1', async () => {
    const h = makeIO({ args: ['base64', 'a.txt', 'b.txt'], files: { 'a.txt': 'x', 'b.txt': 'y' } });
    expect(await base64Command(h.io)).toBe(1);
    expect(h.err()).toBe('base64: extra operand ‘b.txt’\nTry \'base64 --help\' for more information.\n');
  });

  test('a missing FILE errors and exits 1', async () => {
    const h = makeIO({ args: ['base64', 'nope.txt'], files: {} });
    expect(await base64Command(h.io)).toBe(1);
    expect(h.err()).toBe('base64: nope.txt: No such file or directory\n');
  });

  test('-d -i ignores non-alphabet garbage', async () => {
    const h = makeIO({ args: ['base64', '-d', '-i'], stdinText: 'aGVsbG8=\n!!!\n' });
    expect(await base64Command(h.io)).toBe(0);
    expect(new TextDecoder().decode(h.out())).toBe('hello');
  });

  test('-d without -i rejects garbage (exit 1)', async () => {
    const h = makeIO({ args: ['base64', '-d'], stdinText: 'aGVsbG8=\n!!!\n' });
    expect(await base64Command(h.io)).toBe(1);
    expect(h.err()).toBe('base64: invalid input\n');
  });

  test('an unknown short flag errors like GNU (exit 1)', async () => {
    const h = makeIO({ args: ['base64', '-Z'], stdinText: '' });
    expect(await base64Command(h.io)).toBe(1);
    expect(h.err()).toBe('base64: invalid option -- \'Z\'\nTry \'base64 --help\' for more information.\n');
  });

  test('an unknown long flag errors like GNU (exit 1)', async () => {
    const h = makeIO({ args: ['base64', '--bogus'], stdinText: '' });
    expect(await base64Command(h.io)).toBe(1);
    expect(h.err()).toBe('base64: unrecognized option \'--bogus\'\nTry \'base64 --help\' for more information.\n');
  });

  // GNU parity: unpadded (non-multiple-of-4) input decodes; only truly-impossible
  // tails error. Regression for the incomplete-fix finding.
  test('-d decodes unpadded input (7 chars → 5 bytes), exit 0', async () => {
    const h = makeIO({ args: ['base64', '-d'], stdinText: 'aGVsbG8' });
    expect(await base64Command(h.io)).toBe(0);
    expect(new TextDecoder().decode(h.out())).toBe('hello');
  });

  test('-d emits the decoded prefix then errors on a malformed tail', async () => {
    // 'aGVsbG9' → 'hello' then a nonzero-trailing-bit tail → exit 1.
    const h = makeIO({ args: ['base64', '-d'], stdinText: 'aGVsbG9' });
    expect(await base64Command(h.io)).toBe(1);
    expect(new TextDecoder().decode(h.out())).toBe('hello');
    expect(h.err()).toBe('base64: invalid input\n');
  });
});

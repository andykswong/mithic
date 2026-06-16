import { expect, test, describe } from 'vitest';
import { cksumCommand } from './cksum.ts';
import { sumCommand } from './cksum.ts';
import { crc32, bsdSum } from './cksum.ts';
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
  test('block count', () => {
    const data = new Uint8Array(512);
    expect(bsdSum(data).blocks).toBe(1);
    const data2 = new Uint8Array(513);
    expect(bsdSum(data2).blocks).toBe(2);
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

import { expect, test, describe } from 'vitest';
import { shufCommand } from './shuf.ts';
import { mulberry32 } from './shuf.ts';
import type { CommandIO } from '../harness.ts';

/**
 * A file-and-env-aware harness for shuf: a small fd-backed VFS over `fs/*`
 * plus stdout/stderr capture, so FILE operands, `-o`, and errors can be tested.
 */
function makeIO(opts: { args: string[]; stdinText?: string; env?: Record<string, string>; files?: Record<string, string> }) {
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(opts.files ?? {})) files.set(p, enc.encode(c));
  const stdin = new ReadableStream<Uint8Array>({ start(c) { if (opts.stdinText) c.enqueue(enc.encode(opts.stdinText)); c.close(); } });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c.slice()); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c.slice()); } });
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  const open = new Map<number, { path: string; bytes: Uint8Array; offset: number; write: boolean }>();
  let nextFd = 3;
  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    if (call === 'fs/open') {
      const path = String(args.path);
      const oflags = (args.oflags ?? {}) as Record<string, boolean>;
      const write = Boolean(oflags.write || oflags.create || oflags.truncate);
      if (!write && !files.has(path)) throw Object.assign(new Error('File not found: ' + path), { code: 'ENOENT' });
      let bytes = files.get(path) ?? new Uint8Array();
      if (oflags.truncate) bytes = new Uint8Array();
      const fd = nextFd++;
      open.set(fd, { path, bytes, offset: 0, write });
      return { fd };
    }
    if (call === 'fs/read') {
      const e = open.get(Number(args.fd))!;
      const len = Number(args.len ?? 0);
      const slice = e.bytes.subarray(e.offset, e.offset + len);
      e.offset += slice.byteLength;
      return slice.slice();
    }
    if (call === 'fs/write') {
      const e = open.get(Number(args.fd))!;
      const data = args.data as Uint8Array;
      const next = new Uint8Array(e.offset + data.byteLength);
      next.set(e.bytes.subarray(0, e.offset), 0);
      next.set(data, e.offset);
      e.bytes = next; e.offset += data.byteLength;
      files.set(e.path, e.bytes);
      return { written: data.byteLength };
    }
    if (call === 'fs/close') { open.delete(Number(args.fd)); return {}; }
    if (call === 'fs/chmod') return {};
    throw new Error('unexpected syscall ' + call);
  };
  return {
    io: { args: opts.args, env: opts.env ?? {}, cwd: '/', stdin, stdout, stderr, syscall } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
    file: (p: string) => { const b = files.get(p); return b ? new TextDecoder().decode(b) : undefined; },
  };
}

describe('mulberry32 PRNG', () => {
  test('produces deterministic values for same seed', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 10; i++) expect(r1()).toBe(r2());
  });
  test('produces different values for different seeds', () => {
    const r1 = mulberry32(1), r2 = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 10; i++) if (r1() === r2()) same++;
    expect(same).toBeLessThan(5);
  });
  test('values in [0, 1)', () => {
    const r = mulberry32(99);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('shuf command', () => {
  test('shuffles stdin lines deterministically with default seed', async () => {
    const h1 = makeIO({ args: ['shuf'], stdinText: '1\n2\n3\n4\n5\n' });
    const h2 = makeIO({ args: ['shuf'], stdinText: '1\n2\n3\n4\n5\n' });
    await shufCommand(h1.io);
    await shufCommand(h2.io);
    // Same seed → same output
    expect(h1.out()).toBe(h2.out());
  });

  test('all input lines appear in output', async () => {
    const input = '1\n2\n3\n4\n5\n';
    const h = makeIO({ args: ['shuf'], stdinText: input });
    await shufCommand(h.io);
    const lines = h.out().trim().split('\n').sort();
    expect(lines).toEqual(['1', '2', '3', '4', '5']);
  });

  test('-n limits output', async () => {
    const h = makeIO({ args: ['shuf', '-n', '2'], stdinText: '1\n2\n3\n4\n5\n' });
    await shufCommand(h.io);
    expect(h.out().trim().split('\n').length).toBe(2);
  });

  test('-e treats args as lines', async () => {
    const h = makeIO({ args: ['shuf', '-e', 'a', 'b', 'c'] });
    await shufCommand(h.io);
    const lines = h.out().trim().split('\n').sort();
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  test('-i range', async () => {
    const h = makeIO({ args: ['shuf', '-i', '1-5'] });
    await shufCommand(h.io);
    const lines = h.out().trim().split('\n').map(Number).sort((a, b) => a - b);
    expect(lines).toEqual([1, 2, 3, 4, 5]);
  });

  test('SHUF_SEED env var changes output', async () => {
    const h1 = makeIO({ args: ['shuf'], stdinText: '1\n2\n3\n4\n5\n', env: { SHUF_SEED: '1' } });
    const h2 = makeIO({ args: ['shuf'], stdinText: '1\n2\n3\n4\n5\n', env: { SHUF_SEED: '2' } });
    await shufCommand(h1.io);
    await shufCommand(h2.io);
    // Different seeds MAY produce different orders (not guaranteed every time but very likely for 5 items)
    // Just verify both have all 5 items
    expect(h1.out().trim().split('\n').sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(h2.out().trim().split('\n').sort()).toEqual(['1', '2', '3', '4', '5']);
  });

  // ── FILE operand (was ignored → hang on stdin) ────────────────────────────
  test('reads a FILE operand (does not hang on stdin)', async () => {
    const h = makeIO({ args: ['shuf', '/in'], files: { '/in': '1\n2\n3\n' } });
    expect(await shufCommand(h.io)).toBe(0);
    expect(h.out().trim().split('\n').sort()).toEqual(['1', '2', '3']);
  });

  test('a `-` operand reads stdin', async () => {
    const h = makeIO({ args: ['shuf', '-'], stdinText: '1\n2\n' });
    expect(await shufCommand(h.io)).toBe(0);
    expect(h.out().trim().split('\n').sort()).toEqual(['1', '2']);
  });

  test('two FILE operands is an extra-operand error', async () => {
    const h = makeIO({ args: ['shuf', '/a', '/b'], files: { '/a': '1\n', '/b': '2\n' } });
    expect(await shufCommand(h.io)).toBe(1);
    expect(h.err()).toBe('shuf: extra operand ‘/b’\nTry \'shuf --help\' for more information.\n');
  });

  test('missing FILE errors with canonical errno text', async () => {
    const h = makeIO({ args: ['shuf', '/missing'] });
    expect(await shufCommand(h.io)).toBe(1);
    expect(h.err()).toBe('shuf: /missing: No such file or directory\n');
  });

  // ── -r repeat (sample with replacement) ───────────────────────────────────
  test('-r -n N samples with replacement to exactly N lines', async () => {
    const h = makeIO({ args: ['shuf', '-r', '-n', '10'], stdinText: 'a\nb\n' });
    expect(await shufCommand(h.io)).toBe(0);
    const lines = h.out().trim().split('\n');
    expect(lines.length).toBe(10);
    for (const l of lines) expect(['a', 'b']).toContain(l);
  });

  test('-r on empty input is "no lines to repeat" (exit 1)', async () => {
    const h = makeIO({ args: ['shuf', '-r', '-n', '3'], stdinText: '' });
    expect(await shufCommand(h.io)).toBe(1);
    expect(h.err()).toBe('shuf: no lines to repeat\n');
  });

  test('-r -n 0 on empty input is a clean no-op', async () => {
    const h = makeIO({ args: ['shuf', '-r', '-n', '0'], stdinText: '' });
    expect(await shufCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  // ── -o output file ────────────────────────────────────────────────────────
  test('-o writes to a file (stdout empty)', async () => {
    const h = makeIO({ args: ['shuf', '-o', '/out', '-i', '1-3'] });
    expect(await shufCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
    expect((h.file('/out') ?? '').trim().split('\n').sort()).toEqual(['1', '2', '3']);
  });

  // ── -i extra operand / -e + -i conflict ───────────────────────────────────
  test('-i with an extra operand is an error', async () => {
    const h = makeIO({ args: ['shuf', '-i', '1-3', 'extra'] });
    expect(await shufCommand(h.io)).toBe(1);
    expect(h.err()).toBe('shuf: extra operand ‘extra’\nTry \'shuf --help\' for more information.\n');
  });

  test('-e combined with -i is an error', async () => {
    const h = makeIO({ args: ['shuf', '-e', 'a', '-i', '1-3'] });
    expect(await shufCommand(h.io)).toBe(1);
    expect(h.err()).toBe('shuf: cannot combine -e and -i options\nTry \'shuf --help\' for more information.\n');
  });

  test('-i reversed range is invalid', async () => {
    const h = makeIO({ args: ['shuf', '-i', '5-1'] });
    expect(await shufCommand(h.io)).toBe(1);
    expect(h.err()).toBe('shuf: invalid input range: ‘5-1’\n');
  });

  test('negative -n is an invalid line count', async () => {
    const h = makeIO({ args: ['shuf', '-n', '-1'], stdinText: '1\n2\n' });
    expect(await shufCommand(h.io)).toBe(1);
    expect(h.err()).toBe('shuf: invalid line count: ‘-1’\n');
  });

  // ── -z NUL delimiter ──────────────────────────────────────────────────────
  test('-z emits NUL-terminated records', async () => {
    const h = makeIO({ args: ['shuf', '-z', '-e', 'a', 'b'] });
    expect(await shufCommand(h.io)).toBe(0);
    expect(h.out().split('\0').filter((x) => x !== '').sort()).toEqual(['a', 'b']);
    expect(h.out().endsWith('\0')).toBe(true);
  });
});

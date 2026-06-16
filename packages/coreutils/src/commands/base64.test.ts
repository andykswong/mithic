import { expect, test, describe } from 'vitest';
import { base64Command } from './base64.ts';
import { b64Encode, b64Decode } from './base64.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: {
  args: string[];
  stdinBytes?: Uint8Array;
  stdinText?: string;
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
  return {
    io: { args: opts.args, env: {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) },
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
});

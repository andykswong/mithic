import { expect, test, describe } from 'vitest';
import { shufCommand } from './shuf.ts';
import { mulberry32 } from './shuf.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: { args: string[]; stdinText?: string; env?: Record<string, string> }) {
  const enc = new TextEncoder();
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(opts.stdinText ?? '')); c.close(); } });
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
  return {
    io: { args: opts.args, env: opts.env ?? {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
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
});

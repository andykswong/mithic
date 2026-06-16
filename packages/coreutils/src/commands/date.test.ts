import { expect, test, describe } from 'vitest';
import { dateCommand } from './date.ts';
import { formatDate } from './date.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(args: string[]) {
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
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
    io: { args, env: {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
  };
}

// Known epoch: 2024-01-15 12:30:45 UTC = 1705321845
const EPOCH = 1705321845;

describe('formatDate', () => {
  test('%Y %m %d %H %M %S in UTC', () => {
    expect(formatDate('%Y-%m-%d %H:%M:%S', EPOCH, true)).toBe('2024-01-15 12:30:45');
  });
  test('%s returns epoch seconds', () => {
    expect(formatDate('%s', EPOCH, true)).toBe(String(EPOCH));
  });
  test('%a weekday abbr', () => {
    // 2024-01-15 is a Monday
    expect(formatDate('%a', EPOCH, true)).toBe('Mon');
  });
  test('%b month abbr', () => {
    expect(formatDate('%b', EPOCH, true)).toBe('Jan');
  });
  test('%B month full', () => {
    expect(formatDate('%B', EPOCH, true)).toBe('January');
  });
  test('%% literal percent', () => {
    expect(formatDate('%%', EPOCH, true)).toBe('%');
  });
  test('%F ISO date', () => {
    expect(formatDate('%F', EPOCH, true)).toBe('2024-01-15');
  });
  test('%T time', () => {
    expect(formatDate('%T', EPOCH, true)).toBe('12:30:45');
  });
  test('%e space-padded day', () => {
    expect(formatDate('%e', EPOCH, true)).toBe('15');
  });
});

describe('date command', () => {
  test('-d epoch formats correctly', async () => {
    const h = makeIO(['date', '-u', '-d', String(EPOCH), '+%Y-%m-%d %H:%M:%S']);
    const code = await dateCommand(h.io);
    expect(code).toBe(0);
    expect(h.out()).toBe('2024-01-15 12:30:45\n');
  });

  test('-d ISO 8601 date', async () => {
    const h = makeIO(['date', '-u', '-d', '2024-01-15T12:30:45Z', '+%Y-%m-%d']);
    expect(await dateCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2024-01-15\n');
  });

  test('no args prints current date (smoke test: just exits 0)', async () => {
    const h = makeIO(['date']);
    expect(await dateCommand(h.io)).toBe(0);
    expect(h.out().trim().length).toBeGreaterThan(5);
  });

  test('invalid -d value exits 1', async () => {
    const h = makeIO(['date', '-d', 'not-a-date']);
    expect(await dateCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid');
  });
});

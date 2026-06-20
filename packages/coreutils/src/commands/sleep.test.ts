import { expect, test, describe } from 'vitest';
import { sleepCommand } from './sleep.ts';
import { parseSleepArg } from './sleep.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(args: string[]) {
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write() {} });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  return {
    io: { args, env: {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO,
    err: () => decode(errChunks),
  };
}

describe('parseSleepArg', () => {
  test('plain seconds', () => expect(parseSleepArg('1')).toBe(1000));
  test('fractional seconds', () => expect(parseSleepArg('0.5')).toBe(500));
  test('explicit s suffix', () => expect(parseSleepArg('2s')).toBe(2000));
  test('minutes', () => expect(parseSleepArg('1m')).toBe(60000));
  test('hours', () => expect(parseSleepArg('1h')).toBe(3600000));
  test('invalid', () => expect(parseSleepArg('abc')).toBeNull());
  test('empty', () => expect(parseSleepArg('')).toBeNull());
  test('days suffix', () => expect(parseSleepArg('1d')).toBe(86400000));
});

describe('sleep command', () => {
  test('sleep 0 exits immediately', async () => {
    const h = makeIO(['sleep', '0']);
    const start = Date.now();
    const code = await sleepCommand(h.io);
    expect(code).toBe(0);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('missing operand exits 1', async () => {
    const h = makeIO(['sleep']);
    expect(await sleepCommand(h.io)).toBe(1);
    expect(h.err()).toContain('missing');
  });

  test('invalid interval exits 1', async () => {
    const h = makeIO(['sleep', 'abc']);
    expect(await sleepCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid');
  });

  test('multiple operands are accepted (GNU sums them); zeros exit fast', async () => {
    const h = makeIO(['sleep', '0', '0', '0']);
    const start = Date.now();
    expect(await sleepCommand(h.io)).toBe(0);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('a single invalid operand among several still errors (exit 1)', async () => {
    const h = makeIO(['sleep', '0', 'xyz']);
    expect(await sleepCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid');
  });
});

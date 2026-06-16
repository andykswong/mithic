import { expect, test, describe } from 'vitest';
import { echoCommand } from './echo.ts';
import { processEscapes } from './echo.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(args: string[]) {
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const outChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write() {} });
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  return {
    io: { args, env: {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO,
    out: () => decode(outChunks),
  };
}

describe('processEscapes', () => {
  test('\\n becomes newline', () => expect(processEscapes('a\\nb')).toBe('a\nb'));
  test('\\t becomes tab', () => expect(processEscapes('a\\tb')).toBe('a\tb'));
  test('\\\\ becomes backslash', () => expect(processEscapes('\\\\')).toBe('\\'));
  test('\\0 octal', () => expect(processEscapes('\\0101')).toBe('A'));
  test('\\xHH hex', () => expect(processEscapes('\\x41')).toBe('A'));
  test('unknown escape passed through', () => expect(processEscapes('\\z')).toBe('\\z'));
});

describe('echo command', () => {
  test('basic string with newline', async () => {
    const h = makeIO(['echo', 'hello', 'world']);
    expect(await echoCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello world\n');
  });

  test('-n suppresses newline', async () => {
    const h = makeIO(['echo', '-n', 'hello']);
    expect(await echoCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello');
  });

  test('-e enables escapes', async () => {
    const h = makeIO(['echo', '-e', 'a\\nb']);
    expect(await echoCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('-E (default) disables escapes', async () => {
    const h = makeIO(['echo', '-E', 'a\\nb']);
    expect(await echoCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\\nb\n');
  });

  test('-en combined flags', async () => {
    const h = makeIO(['echo', '-en', 'a\\tb']);
    expect(await echoCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\tb');
  });

  test('no args outputs empty line', async () => {
    const h = makeIO(['echo']);
    expect(await echoCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\n');
  });

  test('non-flag arg stops flag parsing', async () => {
    // "-n" before non-flag is flag; after "-xyz" which is not purely flags should be literal
    const h = makeIO(['echo', 'hello', '-n', 'world']);
    expect(await echoCommand(h.io)).toBe(0);
    // '-n' here is AFTER a non-flag, so it's a literal
    expect(h.out()).toBe('hello -n world\n');
  });
});

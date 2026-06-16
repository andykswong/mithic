import { expect, test, describe } from 'vitest';
import { printfCommand } from './printf.ts';
import { sprintfAll } from './printf.ts';
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

describe('sprintfAll', () => {
  test('%s basic', () => expect(sprintfAll('%s\n', ['hello'])).toBe('hello\n'));
  test('%d decimal', () => expect(sprintfAll('%d', ['42'])).toBe('42'));
  test('%x hex lowercase', () => expect(sprintfAll('%x', ['255'])).toBe('ff'));
  test('%X hex uppercase', () => expect(sprintfAll('%X', ['255'])).toBe('FF'));
  test('%o octal', () => expect(sprintfAll('%o', ['8'])).toBe('10'));
  test('%c char', () => expect(sprintfAll('%c', ['A'])).toBe('A'));
  test('%% literal percent', () => expect(sprintfAll('%%', [])).toBe('%'));
  test('%5d right-padded', () => expect(sprintfAll('%5d', ['7'])).toBe('    7'));
  test('%-5d left-padded', () => expect(sprintfAll('%-5d', ['7'])).toBe('7    '));
  test('%05d zero-padded', () => expect(sprintfAll('%05d', ['7'])).toBe('00007'));
  test('%f float', () => expect(sprintfAll('%f', ['3.14'])).toBe('3.140000'));
  test('%.2f precision', () => expect(sprintfAll('%.2f', ['3.14159'])).toBe('3.14'));
  test('repeat format over multiple args', () => {
    expect(sprintfAll('%d\n', ['1', '2', '3'])).toBe('1\n2\n3\n');
  });
  test('%b processes escapes in arg', () => {
    expect(sprintfAll('%b', ['a\\nb'])).toBe('a\nb');
  });
  test('\\n in format', () => expect(sprintfAll('a\\nb', [])).toBe('a\nb'));
  test('\\t in format', () => expect(sprintfAll('a\\tb', [])).toBe('a\tb'));

  test('%d parses 0x hex args', () => expect(sprintfAll('%d', ['0xff'])).toBe('255'));
  test('%d parses leading-zero octal args', () => expect(sprintfAll('%d', ['010'])).toBe('8'));
  test('%d parses \'c char-code args', () => expect(sprintfAll('%d', ['\'A'])).toBe('65'));
  test('%x parses 0x hex args', () => expect(sprintfAll('%x', ['0x10'])).toBe('10'));
  test('%o parses hex arg', () => expect(sprintfAll('%o', ['0x8'])).toBe('10'));
  test('%u parses octal arg', () => expect(sprintfAll('%u', ['010'])).toBe('8'));

  test('%g uses scientific for large exponent', () => {
    expect(sprintfAll('%g', ['1000000'])).toBe('1e+06');
  });
  test('%g uses scientific for small exponent', () => {
    expect(sprintfAll('%g', ['0.00001'])).toBe('1e-05');
  });
  test('%g stays fixed within range', () => {
    expect(sprintfAll('%g', ['100000'])).toBe('100000');
    expect(sprintfAll('%g', ['0.0001'])).toBe('0.0001');
  });
  test('%g strips trailing zeros', () => {
    expect(sprintfAll('%g', ['1.5'])).toBe('1.5');
    expect(sprintfAll('%g', ['3'])).toBe('3');
  });
  test('%G uppercases exponent', () => {
    expect(sprintfAll('%G', ['1000000'])).toBe('1E+06');
  });
});

describe('printf command', () => {
  test('basic string', async () => {
    const h = makeIO(['printf', 'hello %s\n', 'world']);
    expect(await printfCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello world\n');
  });

  test('no format — no output, exit 0', async () => {
    const h = makeIO(['printf']);
    expect(await printfCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('multiple args repeat format', async () => {
    const h = makeIO(['printf', '%d\n', '1', '2', '3']);
    expect(await printfCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n3\n');
  });
});

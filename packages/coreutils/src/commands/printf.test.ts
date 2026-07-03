import { expect, test, describe } from 'vitest';
import { printfCommand } from './printf.ts';
import { sprintfAll } from './printf.ts';
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

  // ── GNU-parity gap fixes ─────────────────────────────────────────────────────

  test('%u of -1 is uintmax (64-bit), not >>>0', () => {
    expect(sprintfAll('%u', ['-1'])).toBe('18446744073709551615');
  });
  test('%o of -1 is uintmax octal', () => {
    expect(sprintfAll('%o', ['-1'])).toBe('1777777777777777777777');
  });
  test('%x of -1 is 16 f', () => {
    expect(sprintfAll('%x', ['-1'])).toBe('ffffffffffffffff');
  });
  test('%X of -1 uppercase', () => {
    expect(sprintfAll('%X', ['-1'])).toBe('FFFFFFFFFFFFFFFF');
  });
  test('%d past 2^53 exact via BigInt', () => {
    expect(sprintfAll('%d', ['9007199254740993'])).toBe('9007199254740993');
  });
  test('%e forces 2-digit exponent', () => {
    expect(sprintfAll('%e', ['1000000'])).toBe('1.000000e+06');
  });
  test('%E forces 2-digit exponent', () => {
    expect(sprintfAll('%E', ['1000000'])).toBe('1.000000E+06');
  });
  test('%05d keeps sign before zeros', () => {
    expect(sprintfAll('%05d', ['-42'])).toBe('-0042');
  });
  test('%+05d positive keeps + before zeros', () => {
    expect(sprintfAll('%+05d', ['7'])).toBe('+0007');
  });
  test('%05x zero-pads after alt prefix', () => {
    expect(sprintfAll('%#08x', ['255'])).toBe('0x0000ff');
  });
  test('format-string bare octal \\NNN', () => {
    expect(sprintfAll('\\101', [])).toBe('A');
  });
  test('format-string \\0101 → \\010 + 1', () => {
    expect(sprintfAll('a\\0101b', [])).toBe('a\x081b');
  });
  test('\\c truncates format output', () => {
    expect(sprintfAll('ab\\cde', [])).toBe('ab');
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

  test('%d abc: prints 0, diagnostic on stderr, exit 1', async () => {
    const h = makeIO(['printf', '%d\n', 'abc']);
    expect(await printfCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0\n');
    expect(h.err()).toContain('expected a numeric value');
  });

  test('%d overflow: clamps to INTMAX, diagnostic, exit 1', async () => {
    const h = makeIO(['printf', '%d\n', '99999999999999999999999999']);
    expect(await printfCommand(h.io)).toBe(1);
    expect(h.out()).toBe('9223372036854775807\n');
    expect(h.err()).toContain('Result too large');
  });

  test('%d negative overflow clamps to INTMAX_MIN', async () => {
    const h = makeIO(['printf', '%d\n', '-99999999999999999999999999']);
    expect(await printfCommand(h.io)).toBe(1);
    expect(h.out()).toBe('-9223372036854775808\n');
  });

  test('\\c suppresses the rest of output', async () => {
    const h = makeIO(['printf', 'ab\\cde']);
    expect(await printfCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ab');
  });

  test('\\c inside %b stops all further output including format \\n', async () => {
    const h = makeIO(['printf', '%b\n', 'a\\cb']);
    expect(await printfCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a');
  });
});

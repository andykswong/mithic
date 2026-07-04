import { expect, test, describe } from 'vitest';
import { printfCommand } from './printf.ts';
import { sprintfAll, sprintfFull } from './printf.ts';
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

  // ── round-half-to-EVEN (banker's rounding) for %f/%e/%E/%g, matching C/GNU ──
  // JS toFixed/toExponential round exact .5-ties half-AWAY-from-zero; GNU rounds
  // the true IEEE-754 value half-to-EVEN. Only exactly-representable ties diverge.
  test('%.0f 2.5 → 2 (tie to even)', () => expect(sprintfAll('%.0f', ['2.5'])).toBe('2'));
  test('%.0f 3.5 → 4 (tie to even)', () => expect(sprintfAll('%.0f', ['3.5'])).toBe('4'));
  test('%.0f 0.5 → 0 (tie to even)', () => expect(sprintfAll('%.0f', ['0.5'])).toBe('0'));
  test('%.0f 1.5 → 2 (tie to even)', () => expect(sprintfAll('%.0f', ['1.5'])).toBe('2'));
  test('%.0f 4.5 → 4 (tie to even)', () => expect(sprintfAll('%.0f', ['4.5'])).toBe('4'));
  test('%.0f -2.5 → -2 (tie to even)', () => expect(sprintfAll('%.0f', ['-2.5'])).toBe('-2'));
  test('%.2f 0.125 → 0.12 (exact tie to even)', () => expect(sprintfAll('%.2f', ['0.125'])).toBe('0.12'));
  test('%.2f -0.125 → -0.12 (exact tie to even)', () => expect(sprintfAll('%.2f', ['-0.125'])).toBe('-0.12'));
  test('%.0f 0.45 → 0 (non-representable, rounds down)', () => expect(sprintfAll('%.0f', ['0.45'])).toBe('0'));
  test('%.0f 2.4 → 2 (non-tie)', () => expect(sprintfAll('%.0f', ['2.4'])).toBe('2'));
  test('%.0f 2.6 → 3 (non-tie)', () => expect(sprintfAll('%.0f', ['2.6'])).toBe('3'));
  test('%f 2.5 default 6 digits', () => expect(sprintfAll('%f', ['2.5'])).toBe('2.500000'));
  test('%.3e 12345 → 1.234e+04 (tie to even)', () => expect(sprintfAll('%.3e', ['12345'])).toBe('1.234e+04'));
  test('%.3E 12345 → 1.234E+04', () => expect(sprintfAll('%.3E', ['12345'])).toBe('1.234E+04'));
  test('%.0e 2.5 → 2e+00 (tie to even)', () => expect(sprintfAll('%.0e', ['2.5'])).toBe('2e+00'));
  test('%.3g 12345 → 1.23e+04 (tie to even)', () => expect(sprintfAll('%.3g', ['12345'])).toBe('1.23e+04'));
  test('%.2g 0.125 → 0.12 (tie to even)', () => expect(sprintfAll('%.2g', ['0.125'])).toBe('0.12'));
  test('float ties honour width/flags: %08.2f 2.5', () => expect(sprintfAll('%08.2f', ['2.5'])).toBe('00002.50'));
  test('float ties honour +/space: %+.0f 2.5', () => expect(sprintfAll('%+.0f', ['2.5'])).toBe('+2'));

  // ── %u/%o/%x accept the full uintmax_t range [0, 2^64-1] (parsed as unsigned) ──
  test('%u UINTMAX_MAX (2^64-1) accepted', () => {
    expect(sprintfAll('%u', ['18446744073709551615'])).toBe('18446744073709551615');
  });
  test('%o UINTMAX_MAX octal', () => {
    expect(sprintfAll('%o', ['18446744073709551615'])).toBe('1777777777777777777777');
  });
  test('%x UINTMAX_MAX hex', () => {
    expect(sprintfAll('%x', ['18446744073709551615'])).toBe('ffffffffffffffff');
  });
  test('%u INTMAX_MAX+1 (2^63) accepted, not clamped', () => {
    expect(sprintfAll('%u', ['9223372036854775808'])).toBe('9223372036854775808');
  });
  test('%x above INTMAX_MAX accepted', () => {
    expect(sprintfAll('%x', ['9223372036854775808'])).toBe('8000000000000000');
  });

  // ── M1: FORMAT-string \xHH hex escapes (GNU handles these in the format too) ──
  test('format \\x41\\x42 → AB', () => expect(sprintfAll('\\x41\\x42\\n', [])).toBe('AB\n'));
  test('format \\x0a → newline', () => expect(sprintfAll('\\x0a', [])).toBe('\n'));
  test('format \\x9 (1 hex digit) → tab', () => expect(sprintfAll('\\x9', [])).toBe('\t'));
  test('format \\xff → byte 0xff', () => expect(sprintfAll('\\xff', [])).toBe('\xff'));

  // ── DEFECT 7: \x with zero hex digits is a GNU error (not literal \x) ──
  test('format \\x with no hex digit → error, no output', () => {
    const r = sprintfFull('\\x', []);
    expect(r.text).toBe('');
    expect(r.truncated).toBe(true);
    expect(r.diags.some((d) => d.message.includes('missing hexadecimal number in escape'))).toBe(true);
  });
  test('format a\\x → emits "a" then errors', () => {
    const r = sprintfFull('a\\x', []);
    expect(r.text).toBe('a');
    expect(r.diags.some((d) => d.message.includes('missing hexadecimal number in escape'))).toBe(true);
  });
  test('format X\\xgY → emits "X" then errors (stops before g)', () => {
    const r = sprintfFull('X\\xgY', []);
    expect(r.text).toBe('X');
    expect(r.truncated).toBe(true);
    expect(r.diags.some((d) => d.message.includes('missing hexadecimal number in escape'))).toBe(true);
  });

  // ── DEFECT P1: \x with no hex digit is a GNU error in %b args too ──
  test('%b a\\x → emits "a" then errors (missing hex)', () => {
    const r = sprintfFull('%b', ['a\\x']);
    expect(r.text).toBe('a');
    expect(r.truncated).toBe(true);
    expect(r.diags.some((d) => d.message.includes('missing hexadecimal number in escape'))).toBe(true);
  });
  test('%b a\\xgb → emits "a" then errors (stops before g)', () => {
    const r = sprintfFull('%b', ['a\\xgb']);
    expect(r.text).toBe('a');
    expect(r.truncated).toBe(true);
    expect(r.diags.some((d) => d.message.includes('missing hexadecimal number in escape'))).toBe(true);
  });
  test('%b a\\x1 → 0x01 control preserved', () => expect(sprintfAll('%b', ['a\\x1'])).toBe('a\x01'));
  test('%b a\\x41 → aA control preserved', () => expect(sprintfAll('%b', ['a\\x41'])).toBe('aA'));

  // ── L1: %q shell-quote conversion (matches GNU printf %q) ──
  test('%q empty → \'\'', () => expect(sprintfAll('%q\n', [''])).toBe('\'\'\n'));
  test('%q plain word unquoted', () => expect(sprintfAll('%q\n', ['plain'])).toBe('plain\n'));
  test('%q space → single-quoted', () => expect(sprintfAll('%q\n', ['a b'])).toBe('\'a b\'\n'));
  test('%q dollar → single-quoted', () => expect(sprintfAll('%q\n', ['a$b'])).toBe('\'a$b\'\n'));
  test('%q double-quote → single-quoted', () => expect(sprintfAll('%q\n', ['a"b'])).toBe('\'a"b\'\n'));
  test('%q single-quote only → double-quoted', () => expect(sprintfAll('%q\n', ['a\'b'])).toBe('"a\'b"\n'));
  test('%q single-quote + metachar → escaped single-quote', () =>
    expect(sprintfAll('%q', ['a=\'b'])).toBe('\'a=\'\\\'\'b\''));
  test('%q single-quote + double-quote → escaped single-quote', () =>
    expect(sprintfAll('%q', ['a\'b"c'])).toBe('\'a\'\\\'\'b"c\''));
  test('%q newline → $\'\\n\' mixed form', () =>
    expect(sprintfAll('%q', ['a\nb'])).toBe('\'a\'$\'\\n\'\'b\''));
  test('%q tab → $\'\\t\' mixed form', () =>
    expect(sprintfAll('%q', ['a\tb'])).toBe('\'a\'$\'\\t\'\'b\''));
  test('%q leading control → \'\'$\'\\001\'', () =>
    expect(sprintfAll('%q', ['\x01'])).toBe('\'\'$\'\\001\''));
  test('%q DEL byte → octal escape', () =>
    expect(sprintfAll('%q', ['a\x7fb'])).toBe('\'a\'$\'\\177\'\'b\''));
  test('%q leading # quoted', () => expect(sprintfAll('%q', ['#ab'])).toBe('\'#ab\''));
  test('%q non-leading # bare', () => expect(sprintfAll('%q', ['a#b'])).toBe('a#b'));
  test('%q leading ~ quoted', () => expect(sprintfAll('%q', ['~ab'])).toBe('\'~ab\''));
  test('%q non-leading ~ bare', () => expect(sprintfAll('%q', ['a~b'])).toBe('a~b'));
  test('%q = always quoted', () => expect(sprintfAll('%q', ['a=b'])).toBe('\'a=b\''));
  test('%q standalone { quoted', () => expect(sprintfAll('%q', ['{'])).toBe('\'{\''));
  test('%q { in longer string bare', () => expect(sprintfAll('%q', ['a{b'])).toBe('a{b'));
  test('%q backslash quoted', () => expect(sprintfAll('%q', ['a\\b'])).toBe('\'a\\b\''));
  test('%q repeats over multiple args', () =>
    expect(sprintfAll('%q\n', ['a b', 'c d'])).toBe('\'a b\'\n\'c d\'\n'));
  test('%q consumes exactly one arg (no format doubling)', () =>
    expect(sprintfAll('[%q]', ['x'])).toBe('[x]'));

  // ── DEFECT 8: %q escapes UTF-8 BYTES (LC_ALL=C), not JS UTF-16 code units ──
  test('%q multibyte café → UTF-8 byte octals', () =>
    expect(sprintfAll('%q', ['café'])).toBe('\'caf\'$\'\\303\\251\''));
  test('%q astral emoji → 4 UTF-8 byte octals', () =>
    expect(sprintfAll('%q', ['😀'])).toBe('\'\'$\'\\360\\237\\230\\200\''));
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

  test('%u UINTMAX_MAX: exits 0, no diagnostic (parsed as uintmax_t)', async () => {
    const h = makeIO(['printf', '%u\n', '18446744073709551615']);
    expect(await printfCommand(h.io)).toBe(0);
    expect(h.out()).toBe('18446744073709551615\n');
    expect(h.err()).toBe('');
  });

  test('%u above UINTMAX_MAX: saturates + Result too large, exit 1', async () => {
    const h = makeIO(['printf', '%u\n', '18446744073709551616']);
    expect(await printfCommand(h.io)).toBe(1);
    expect(h.out()).toBe('18446744073709551615\n');
    expect(h.err()).toContain('Result too large');
  });

  test('%.0f 2.5 tie-to-even prints 2, exit 0', async () => {
    const h = makeIO(['printf', '%.0f\n', '2.5']);
    expect(await printfCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2\n');
  });
});

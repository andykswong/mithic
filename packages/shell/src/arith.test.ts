import { expect, test } from 'vitest';
import { evalArith } from './arith.ts';

// evalArith now returns a 64-bit bigint; these small-value assertions coerce to a
// JS number for readability. 64-bit-precision cases are asserted separately below.
const ev = (src: string, env: Record<string, string> = {}) => {
  const e = { ...env };
  return { value: Number(evalArith(src, e)), env: e };
};

test('basic arithmetic operators', () => {
  expect(ev('1 + 2').value).toBe(3);
  expect(ev('10 - 4').value).toBe(6);
  expect(ev('3 * 4').value).toBe(12);
  expect(ev('15 / 4').value).toBe(3); // integer division
  expect(ev('17 % 5').value).toBe(2);
  expect(ev('2 ** 10').value).toBe(1024);
});

test('precedence and parentheses', () => {
  expect(ev('2 + 3 * 4').value).toBe(14);
  expect(ev('(2 + 3) * 4').value).toBe(20);
  expect(ev('2 ** 3 ** 2').value).toBe(512); // right-assoc
});

test('bitwise and shift', () => {
  expect(ev('6 & 3').value).toBe(2);
  expect(ev('6 | 1').value).toBe(7);
  expect(ev('6 ^ 3').value).toBe(5);
  expect(ev('~0').value).toBe(-1);
  expect(ev('1 << 4').value).toBe(16);
  expect(ev('256 >> 2').value).toBe(64);
});

test('comparison and logical operators', () => {
  expect(ev('3 < 5').value).toBe(1);
  expect(ev('5 < 3').value).toBe(0);
  expect(ev('3 <= 3').value).toBe(1);
  expect(ev('4 == 4').value).toBe(1);
  expect(ev('4 != 4').value).toBe(0);
  expect(ev('1 && 0').value).toBe(0);
  expect(ev('1 || 0').value).toBe(1);
  expect(ev('!0').value).toBe(1);
  expect(ev('!5').value).toBe(0);
});

test('ternary', () => {
  expect(ev('1 ? 10 : 20').value).toBe(10);
  expect(ev('0 ? 10 : 20').value).toBe(20);
});

test('variables resolve from env (bare names)', () => {
  expect(ev('x + 1', { x: '41' }).value).toBe(42);
  expect(ev('$x + 1', { x: '41' }).value).toBe(42);
  expect(ev('unset + 5').value).toBe(5); // unset → 0
});

test('assignment mutates env and returns value', () => {
  const r = ev('x = 7', {});
  expect(r.value).toBe(7);
  expect(r.env.x).toBe('7');
});

test('compound assignment', () => {
  const r = ev('x += 3', { x: '5' });
  expect(r.value).toBe(8);
  expect(r.env.x).toBe('8');
});

test('pre/post increment and decrement', () => {
  const r1 = ev('++x', { x: '5' });
  expect(r1.value).toBe(6);
  expect(r1.env.x).toBe('6');
  const r2 = ev('x++', { x: '5' });
  expect(r2.value).toBe(5);
  expect(r2.env.x).toBe('6');
  const r3 = ev('x--', { x: '5' });
  expect(r3.value).toBe(5);
  expect(r3.env.x).toBe('4');
});

test('comma operator returns last', () => {
  expect(ev('1, 2, 3').value).toBe(3);
});

test('hex and octal literals', () => {
  expect(ev('0xff').value).toBe(255);
  expect(ev('010').value).toBe(8);
});

// ── WP-C: base literals, array-element lvalues, hex width ────────────────────

test('base#num literals (2..64)', () => {
  expect(ev('16#ff').value).toBe(255);
  expect(ev('2#1010').value).toBe(10);
  expect(ev('8#17').value).toBe(15);
  expect(ev('36#z').value).toBe(35);
  expect(ev('10#08').value).toBe(8);      // force decimal on a leading-zero string
  expect(ev('16#FF').value).toBe(255);    // case-insensitive for base ≤ 36
  expect(ev('64#A').value).toBe(36);      // base 64: A → 36
});

test('base#num rejects a bad base / digit', () => {
  expect(() => ev('16#g')).toThrow();     // g ≥ 16
  expect(() => ev('99#1')).toThrow();     // base out of range
});

test('hex literals ≥ 0x80000000 are not signed-32 truncated', () => {
  expect(ev('0xFFFFFFFF').value).toBe(4294967295);
  expect(ev('0x80000000').value).toBe(2147483648);
  expect(ev('0xFFFFFFFF + 1').value).toBe(4294967296);
  expect(ev('0x1F').value).toBe(31);
});

test('array-element lvalues a[i]++ / a[i]+=n via an ArithArrayAccess', () => {
  const store: Record<string, string[]> = { a: ['1', '2', '3'] };
  const access = {
    getElement: (n: string, i: number) => store[n]?.[i],
    setElement: (n: string, i: number, v: string) => { (store[n] ??= [])[i] = v; },
  };
  expect(evalArith('a[1]+=10', {}, access)).toBe(12n);
  expect(store.a[1]).toBe('12');
  expect(evalArith('a[0]++', {}, access)).toBe(1n);
  expect(store.a[0]).toBe('2');
});

test('64-bit intmax_t semantics (BigInt): shifts, precision, twos-complement wrap', () => {
  // `1 << 62` is exact (was 32-bit-truncated before).
  expect(evalArith('1 << 62', {})).toBe(4611686018427387904n);
  expect(evalArith('2 ** 40', {})).toBe(1099511627776n);
  // Values beyond 2^53 keep full precision.
  expect(evalArith('9223372036854775807', {})).toBe(9223372036854775807n);
  // INTMAX_MAX + 1 wraps to INTMAX_MIN (two's-complement).
  expect(evalArith('9223372036854775807 + 1', {})).toBe(-9223372036854775808n);
  // A shift amount is taken modulo 64.
  expect(evalArith('1 << 64', {})).toBe(1n);
  // Bitwise ops operate on the 64-bit value.
  expect(evalArith('~0', {})).toBe(-1n);
});

test('&& / || / ?: short-circuit — the untaken side is not evaluated', () => {
  // Untaken ternary arm side effect is suppressed.
  const e1 = { x: '0' };
  expect(evalArith('1 ? 10 : (x=99)', e1)).toBe(10n);
  expect(e1.x).toBe('0');
  // || short-circuits: RHS assignment does not run when LHS is true.
  const e2 = {};
  expect(evalArith('1 || (c=5)', e2)).toBe(1n);
  expect((e2 as Record<string, string>).c).toBeUndefined();
  // && short-circuits: RHS divide-by-zero does NOT throw when LHS is false.
  expect(evalArith('0 && 1/0', {})).toBe(0n);
  expect(evalArith('5 || 0/0', {})).toBe(1n);
});

test('subscript side effects in a dead branch are suppressed (inherit suppress)', () => {
  // `0 ? a[i++] : 9` must NOT increment i (the subscript is in the untaken arm).
  const acc = (store: Record<string, string[]>) => ({
    getElement: (n: string, i: number) => store[n]?.[i],
    setElement: (n: string, i: number, v: string) => { (store[n] ??= [])[i] = v; },
  });
  const e1: Record<string, string> = { i: '0' };
  expect(evalArith('0 ? a[i++] : 9', e1, acc({ a: ['5', '6'] }))).toBe(9n);
  expect(e1.i).toBe('0'); // unchanged
  // The LIVE branch still increments.
  const e2: Record<string, string> = { i: '0' };
  expect(evalArith('1 ? a[i++] : 9', e2, acc({ a: ['5', '6'] }))).toBe(5n);
  expect(e2.i).toBe('1');
});

test('leading-zero values are octal; invalid octal / negative exponent error', () => {
  // A leading-zero VARIABLE value is octal (n=017 → 15).
  expect(evalArith('n', { n: '017' })).toBe(15n);
  expect(evalArith('n + 1', { n: '010' })).toBe(9n);
  // Octal literals.
  expect(evalArith('017', {})).toBe(15n);
  // Invalid octal digit → error (both literal and variable value).
  expect(() => evalArith('08', {})).toThrow(/value too great for base/);
  expect(() => evalArith('n', { n: '09' })).toThrow(/value too great for base/);
  // Negative exponent is a bash error.
  expect(() => evalArith('2 ** -1', {})).toThrow(/exponent less than 0/);
});

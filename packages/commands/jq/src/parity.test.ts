/**
 * Parity regression tests for the JQ-cluster findings (J1–J5 + LOW items).
 * Each case targets real jq 1.7 behavior; see docs/isola/003-parity-review.md.
 */
import { expect, test } from 'vitest';
import { run, compile, HaltError, JQError } from './engine.ts';
import { formatNumber, toJSON } from './values.ts';

const r = (prog: string, input: unknown, opts?: Parameters<typeof run>[2]): unknown[] => run(prog, input, opts);
const r1 = (prog: string, input: unknown, opts?: Parameters<typeof run>[2]): unknown => run(prog, input, opts)[0];

/** Run a program to completion and return whatever it threw (or undefined). */
function thrownBy(prog: string, input: unknown, opts?: Parameters<typeof run>[2]): unknown {
  try { const out = [...run(prog, input, opts)]; void out; return undefined; }
  catch (e) { return e; }
}

// ── J1: invalid/unknown @format raises a JQError (not a raw TypeError) ────────

test('J1: bare invalid @format raises a JQError, not a TypeError', () => {
  // Before the fix this threw a raw TypeError ("Cannot read properties of
  // undefined (reading 'JQError')") because the builtins `H` table was unset.
  const caught = thrownBy('@foobar', 'x');
  expect(caught).toBeInstanceOf(JQError);
  expect((caught as JQError).value).toBe('@foobar is not a valid format');
});

test('J1: invalid @format inside string interpolation raises a JQError', () => {
  // The format is applied as a filter; an unknown one must be a clean JQError.
  const caught = thrownBy('"\\(.)" | @nope', { a: 1 });
  expect(caught).toBeInstanceOf(JQError);
});

test('J1: a valid @format still works as a first/only op', () => {
  expect(r1('@base64', 'hello')).toBe('aGVsbG8=');
  expect(r1('@text', 5)).toBe('5');
});

// ── J2: halt / halt_error are NOT catchable by try; they unwind the program ───

test('J2: `try halt catch .` still halts (catch does not see it as data)', () => {
  const caught = thrownBy('try halt catch .', { a: 1 });
  expect(caught).toBeInstanceOf(HaltError);
  // HaltError is deliberately NOT a JQError, so `try`/`catch` cannot swallow it.
  expect(caught).not.toBeInstanceOf(JQError);
  expect((caught as HaltError).__halt).toBe(true);
  expect((caught as HaltError).code).toBe(0);
});

test('J2: `try halt_error catch .` still halts with the error value/code', () => {
  const caught = thrownBy('try halt_error catch .', 'boom');
  expect(caught).toBeInstanceOf(HaltError);
  expect((caught as HaltError).__halt).toBe(true);
  expect((caught as HaltError).code).toBe(5);
  expect((caught as HaltError).value).toBe('boom');
});

test('J2: halt_error(N) propagates the requested exit code past try', () => {
  const caught = thrownBy('try (halt_error(3)) catch "swallowed"', 'x');
  expect(caught).toBeInstanceOf(HaltError);
  expect((caught as HaltError).code).toBe(3);
});

test('J2: halt is not swallowed by ? operator either', () => {
  const caught = thrownBy('halt?', null);
  expect(caught).toBeInstanceOf(HaltError);
  expect((caught as HaltError).__halt).toBe(true);
});

test('J2: a normal error is still catchable (regression guard)', () => {
  expect(r('try error("x") catch .', null)).toEqual(['x']);
});

// ── J3: @uri encodes the full reserved set jq encodes ─────────────────────────

test('J3: @uri percent-encodes ! * \' ( ) and other reserved chars', () => {
  expect(r1('@uri', 'a!b*c\'d(e)')).toBe('a%21b%2Ac%27d%28e%29');
  // unreserved set (A-Za-z0-9-_.~) passes through untouched
  expect(r1('@uri', 'AZaz09-_.~')).toBe('AZaz09-_.~');
  // space and ampersand still encode
  expect(r1('@uri', 'a b&c')).toBe('a%20b%26c');
  // multibyte UTF-8 is percent-encoded byte by byte
  expect(r1('@uri', 'é')).toBe('%C3%A9');
});

// ── J4: missing builtins ──────────────────────────────────────────────────────

test('J4: scan/1 returns whole match when no capture groups', () => {
  expect(r('scan("[0-9]+")', 'a1b23c456')).toEqual(['1', '23', '456']);
});

test('J4: scan/1 returns capture arrays when the regex has groups', () => {
  expect(r('scan("([a-z])([0-9])")', 'a1b2')).toEqual([['a', '1'], ['b', '2']]);
});

test('J4: scan/2 honors flags', () => {
  expect(r('scan("[a-z]+"; "i")', 'AbCdEf')).toEqual(['AbCdEf']);
});

test('J4: transpose', () => {
  expect(r1('transpose', [[1, 2], [3, 4]])).toEqual([[1, 3], [2, 4]]);
  // ragged rows pad missing cells with null
  expect(r1('transpose', [[1], [2, 3]])).toEqual([[1, 2], [null, 3]]);
});

test('J4: path/1 yields the path arrays a filter designates', () => {
  expect(r('path(.a.b)', { a: { b: 1 } })).toEqual([['a', 'b']]);
  expect(r('path(.a[])', { a: [10, 20] })).toEqual([['a', 0], ['a', 1]]);
  expect(r('[path(..)] | length', { a: { b: 1 } })).toEqual([3]);
});

test('J4: isempty/1', () => {
  expect(r1('isempty(empty)', null)).toBe(true);
  expect(r1('isempty(.[])', [])).toBe(true);
  expect(r1('isempty(.[])', [1])).toBe(false);
  // an error raised inside the filter propagates (jq does not swallow it)
  expect(() => r('isempty(error("x"))', null)).toThrow();
});

test('J4: debug passes input through and reports to the debug sink', () => {
  const seen: unknown[] = [];
  expect(r1('debug', { a: 1 }, { debug: (m) => seen.push(m) })).toEqual({ a: 1 });
  expect(seen).toEqual([['DEBUG:', { a: 1 }]]);
});

test('J4: debug/1 evaluates the message filter and passes input through', () => {
  const seen: unknown[] = [];
  expect(r1('debug("msg \\(.x)")', { x: 5 }, { debug: (m) => seen.push(m) })).toEqual({ x: 5 });
  expect(seen).toEqual([['DEBUG:', 'msg 5']]);
});

test('J4: builtins/0 lists known builtins including the newly added ones', () => {
  const names = r1('builtins', null) as string[];
  expect(Array.isArray(names)).toBe(true);
  for (const n of ['scan/1', 'transpose/0', 'path/1', 'isempty/1', 'debug/0', 'length/0']) {
    expect(names).toContain(n);
  }
});

test('J4: input pulls the next value from the input stream', () => {
  const inputs = [10, 20, 30][Symbol.iterator]();
  // model the CLI: the main loop pulls the first value (10) and passes it as
  // the current input; `input` then pulls the *next* stream value.
  const current = inputs.next().value;
  expect(r1('input', current, { inputs })).toBe(20);
});

test('J4: inputs yields all remaining stream values', () => {
  const inputs = [1, 2, 3][Symbol.iterator]();
  expect(r('[inputs]', 0, { inputs })).toEqual([[1, 2, 3]]);
});

test('J4: input errors when the stream is exhausted', () => {
  const inputs = [][Symbol.iterator]();
  expect(() => r('input', null, { inputs })).toThrow();
});

// ── LOW: infinite is a (max-double) number, not null ──────────────────────────

test('LOW: infinite is a number and prints as jq does (max double)', () => {
  expect(typeof r1('infinite', null)).toBe('number');
  expect(r1('infinite > 1e308', null)).toBe(true);
  // jq 1.7 renders +/-infinity clamped to the largest finite double
  const compiled = compile('infinite');
  const out = [...compiled.run(null)][0];
  expect(out).toBe(Infinity);
});

test('LOW: formatNumber clamps +/-infinity to max double (NaN stays null)', () => {
  expect(formatNumber(Infinity)).toBe('1.7976931348623157e+308');
  expect(formatNumber(-Infinity)).toBe('-1.7976931348623157e+308');
  expect(formatNumber(NaN)).toBe('null');
  expect(toJSON(Infinity)).toBe('1.7976931348623157e+308');
});

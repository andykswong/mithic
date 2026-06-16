import { expect, test } from 'vitest';
import { formatOutput, parseInputs, parseJqArgs, parseJsonStream } from './cli.ts';

test('default program is identity', () => {
  expect(parseJqArgs([]).program).toBe('.');
});

test('first positional is the program', () => {
  expect(parseJqArgs(['.foo']).program).toBe('.foo');
});

test('short flags', () => {
  const o = parseJqArgs(['-r', '-c', '.a']);
  expect(o.raw).toBe(true);
  expect(o.compact).toBe(true);
  expect(o.program).toBe('.a');
});

test('clustered short flags', () => {
  const o = parseJqArgs(['-rn', '.']);
  expect(o.raw).toBe(true);
  expect(o.nullInput).toBe(true);
});

test('long flags and indent', () => {
  const o = parseJqArgs(['--raw-output', '--indent', '4', '--sort-keys', '.']);
  expect(o.raw).toBe(true);
  expect(o.indent).toBe(4);
  expect(o.sortKeys).toBe(true);
});

test('--arg and --argjson', () => {
  const o = parseJqArgs(['--arg', 'name', 'andy', '--argjson', 'n', '5', '.']);
  expect(o.args).toEqual({ name: 'andy', n: 5 });
});

test('-j join sets raw', () => {
  const o = parseJqArgs(['-j', '.']);
  expect(o.join).toBe(true);
  expect(o.raw).toBe(true);
});

test('formatOutput compact and pretty', () => {
  const base = parseJqArgs(['.']);
  expect(formatOutput({ a: 1 }, { ...base, compact: true })).toBe('{"a":1}');
  expect(formatOutput({ a: 1 }, { ...base, compact: false })).toBe('{\n  "a": 1\n}');
});

test('formatOutput raw strings', () => {
  const o = parseJqArgs(['-r', '.']);
  expect(formatOutput('hello', o)).toBe('hello');
  expect(formatOutput(5, o)).toBe('5');
});

test('formatOutput sort-keys', () => {
  const o = parseJqArgs(['-cS', '.']);
  expect(formatOutput({ b: 2, a: 1 }, o)).toBe('{"a":1,"b":2}');
});

test('formatOutput ascii-output', () => {
  const o = parseJqArgs(['-ra', '.']);
  expect(formatOutput('café', o)).toBe('caf\\u00e9');
});

test('parseJsonStream multiple values', () => {
  expect(parseJsonStream('1 2 3')).toEqual([1, 2, 3]);
  expect(parseJsonStream('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  expect(parseJsonStream('[1,2]\n[3,4]')).toEqual([[1, 2], [3, 4]]);
  expect(parseJsonStream('"a" "b"')).toEqual(['a', 'b']);
});

test('parseInputs slurp', () => {
  const o = parseJqArgs(['-s', '.']);
  expect(parseInputs('1 2 3', o)).toEqual([[1, 2, 3]]);
});

test('parseInputs raw-input lines', () => {
  const o = parseJqArgs(['-R', '.']);
  expect(parseInputs('foo\nbar\n', o)).toEqual(['foo', 'bar']);
});

test('parseInputs raw-input slurp', () => {
  const o = parseJqArgs(['-Rs', '.']);
  expect(parseInputs('foo\nbar\n', o)).toEqual(['foo\nbar\n']);
});

test('--tab indentation', () => {
  const o = parseJqArgs(['--tab', '.']);
  expect(formatOutput({ a: 1 }, o)).toBe('{\n\t"a": 1\n}');
});

import { expect, test } from 'vitest';
import { run } from './engine.ts';

const r = (prog: string, input: unknown, opts?: Parameters<typeof run>[2]): unknown[] => run(prog, input, opts);

test('identity', () => { expect(r('.', 42)).toEqual([42]); });

test('field access', () => {
  expect(r('.foo', { foo: 1 })).toEqual([1]);
  expect(r('.a.b', { a: { b: 7 } })).toEqual([7]);
  expect(r('.missing', { a: 1 })).toEqual([null]);
});

test('optional field on non-object', () => {
  expect(r('.foo?', 5)).toEqual([]);
  expect(() => r('.foo', 5)).toThrow();
});

test('index and slice', () => {
  expect(r('.[0]', [10, 20])).toEqual([10]);
  expect(r('.[-1]', [10, 20])).toEqual([20]);
  expect(r('.[1:3]', [0, 1, 2, 3, 4])).toEqual([[1, 2]]);
  expect(r('.[2:]', [0, 1, 2, 3])).toEqual([[2, 3]]);
  expect(r('.[:2]', 'hello')).toEqual(['he']);
});

test('iterate', () => {
  expect(r('.[]', [1, 2, 3])).toEqual([1, 2, 3]);
  expect(r('.[]', { a: 1, b: 2 })).toEqual([1, 2]);
  expect(r('.foo[]', { foo: [1, 2] })).toEqual([1, 2]);
});

test('pipe and comma', () => {
  expect(r('.a | .b', { a: { b: 9 } })).toEqual([9]);
  expect(r('.a, .b', { a: 1, b: 2 })).toEqual([1, 2]);
});

test('literals and constructors', () => {
  expect(r('1', null)).toEqual([1]);
  expect(r('"hi"', null)).toEqual(['hi']);
  expect(r('[1,2,3]', null)).toEqual([[1, 2, 3]]);
  expect(r('{a: 1, b: 2}', null)).toEqual([{ a: 1, b: 2 }]);
  expect(r('null, true, false', null)).toEqual([null, true, false]);
});

test('object from input', () => {
  expect(r('{a: .x, b: .y}', { x: 1, y: 2 })).toEqual([{ a: 1, b: 2 }]);
  expect(r('{foo}', { foo: 3, bar: 4 })).toEqual([{ foo: 3 }]);
  expect(r('{(.k): .v}', { k: 'name', v: 5 })).toEqual([{ name: 5 }]);
});

test('arithmetic', () => {
  expect(r('1 + 2 * 3', null)).toEqual([7]);
  expect(r('.a + .b', { a: 3, b: 4 })).toEqual([7]);
  expect(r('. + 1', 10)).toEqual([11]);
  expect(r('10 - 3', null)).toEqual([7]);
  expect(r('10 / 4', null)).toEqual([2.5]);
  expect(r('10 % 3', null)).toEqual([1]);
});

test('string + array + object addition', () => {
  expect(r('"a" + "b"', null)).toEqual(['ab']);
  expect(r('[1] + [2]', null)).toEqual([[1, 2]]);
  expect(r('{a:1} + {b:2}', null)).toEqual([{ a: 1, b: 2 }]);
});

test('comparison and logic', () => {
  expect(r('1 == 1', null)).toEqual([true]);
  expect(r('1 < 2', null)).toEqual([true]);
  expect(r('true and false', null)).toEqual([false]);
  expect(r('true or false', null)).toEqual([true]);
  expect(r('. // "default"', null)).toEqual(['default']);
  expect(r('.a // "default"', { a: 5 })).toEqual([5]);
});

test('string interpolation', () => {
  expect(r('"x=\\(.a)"', { a: 5 })).toEqual(['x=5']);
  expect(r('"\\(.a)+\\(.b)"', { a: 1, b: 2 })).toEqual(['1+2']);
});

test('if/then/elif/else/end', () => {
  expect(r('if . > 5 then "big" else "small" end', 10)).toEqual(['big']);
  expect(r('if . > 5 then "big" else "small" end', 2)).toEqual(['small']);
  expect(r('if . == 1 then "a" elif . == 2 then "b" else "c" end', 2)).toEqual(['b']);
});

test('reduce', () => {
  expect(r('reduce .[] as $x (0; . + $x)', [1, 2, 3, 4])).toEqual([10]);
});

test('foreach', () => {
  expect(r('foreach .[] as $x (0; . + $x)', [1, 2, 3])).toEqual([1, 3, 6]);
  expect(r('foreach .[] as $x (0; . + $x; .)', [1, 2, 3])).toEqual([1, 3, 6]);
});

test('variable binding and destructuring', () => {
  expect(r('. as $x | $x + 1', 5)).toEqual([6]);
  expect(r('. as [$a, $b] | $a + $b', [3, 4])).toEqual([7]);
  expect(r('. as {a: $x} | $x', { a: 9 })).toEqual([9]);
  expect(r('. as {$a} | $a', { a: 11 })).toEqual([11]);
});

test('def functions including recursion', () => {
  expect(r('def inc: . + 1; inc', 5)).toEqual([6]);
  expect(r('def add(a; b): a + b; add(.x; .y)', { x: 2, y: 3 })).toEqual([5]);
  expect(r('def fact: if . <= 1 then 1 else . * (. - 1 | fact) end; fact', 5)).toEqual([120]);
});

test('def with value params', () => {
  expect(r('def f($x): $x * 2; f(.a)', { a: 3 })).toEqual([6]);
});

test('try/catch', () => {
  expect(r('try error("boom") catch .', null)).toEqual(['boom']);
  expect(r('try .a catch "err"', null)).toEqual([null]);
  expect(r('[.[] | try (.+1)]', [1, 'x', 3])).toEqual([[2, 4]]);
});

test('label/break', () => {
  expect(r('label $out | foreach .[] as $x (0; .+$x; if . > 3 then ., break $out else . end)', [1, 2, 3, 4]))
    .toEqual([1, 3, 6]);
});

test('recurse and ..', () => {
  expect(r('[..]', { a: 1 })).toEqual([[{ a: 1 }, 1]]);
  expect(r('[recurse]', [1, [2]])).toEqual([[[1, [2]], 1, [2], 2]]);
});

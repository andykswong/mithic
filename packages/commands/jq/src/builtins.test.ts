import { expect, test } from 'vitest';
import { run } from './engine.ts';

const r = (prog: string, input: unknown, opts?: Parameters<typeof run>[2]): unknown[] => run(prog, input, opts);
const r1 = (prog: string, input: unknown, opts?: Parameters<typeof run>[2]): unknown => run(prog, input, opts)[0];

test('length', () => {
  expect(r1('length', [1, 2, 3])).toBe(3);
  expect(r1('length', 'hello')).toBe(5);
  expect(r1('length', { a: 1, b: 2 })).toBe(2);
  expect(r1('length', null)).toBe(0);
  expect(r1('length', -5)).toBe(5);
});

test('keys / values / has / in', () => {
  expect(r1('keys', { b: 1, a: 2 })).toEqual(['a', 'b']);
  expect(r1('keys', [1, 2, 3])).toEqual([0, 1, 2]);
  // `values` is the non-null selector (passes input through if not null).
  expect(r('values', { a: 1, b: 2 })).toEqual([{ a: 1, b: 2 }]);
  expect(r('values', null)).toEqual([]);
  expect(r('.[] | values', [1, null, 2])).toEqual([1, 2]);
  expect(r1('has("a")', { a: 1 })).toBe(true);
  expect(r1('has(0)', [1])).toBe(true);
  expect(r1('. | in({"a":1})', 'a')).toBe(true);
});

test('contains', () => {
  expect(r1('contains("ell")', 'hello')).toBe(true);
  expect(r1('contains({a:1})', { a: 1, b: 2 })).toBe(true);
  expect(r1('contains([1,2])', [1, 2, 3])).toBe(true);
});

test('map / select / map_values', () => {
  expect(r1('map(. + 1)', [1, 2, 3])).toEqual([2, 3, 4]);
  expect(r('.[] | select(. > 2)', [1, 2, 3, 4])).toEqual([3, 4]);
  expect(r1('map_values(. * 2)', { a: 1, b: 2 })).toEqual({ a: 2, b: 4 });
});

test('add / any / all', () => {
  expect(r1('add', [1, 2, 3])).toBe(6);
  expect(r1('add', ['a', 'b'])).toBe('ab');
  expect(r1('any', [false, true])).toBe(true);
  expect(r1('all', [true, true])).toBe(true);
  expect(r1('any(. > 2)', [1, 2, 3])).toBe(true);
});

test('range', () => {
  expect(r('range(3)', null)).toEqual([0, 1, 2]);
  expect(r('range(1; 4)', null)).toEqual([1, 2, 3]);
  expect(r('range(0; 10; 3)', null)).toEqual([0, 3, 6, 9]);
});

test('floor/ceil/round/sqrt/fabs', () => {
  expect(r1('floor', 3.7)).toBe(3);
  expect(r1('ceil', 3.2)).toBe(4);
  expect(r1('round', 3.5)).toBe(4);
  expect(r1('sqrt', 16)).toBe(4);
  expect(r1('fabs', -5)).toBe(5);
});

test('min/max/min_by/max_by', () => {
  expect(r1('min', [3, 1, 2])).toBe(1);
  expect(r1('max', [3, 1, 2])).toBe(3);
  expect(r1('min_by(.a)', [{ a: 3 }, { a: 1 }])).toEqual({ a: 1 });
  expect(r1('max_by(.a)', [{ a: 3 }, { a: 1 }])).toEqual({ a: 3 });
});

test('sort / sort_by / unique / unique_by / group_by', () => {
  expect(r1('sort', [3, 1, 2])).toEqual([1, 2, 3]);
  expect(r1('sort_by(.a)', [{ a: 2 }, { a: 1 }])).toEqual([{ a: 1 }, { a: 2 }]);
  expect(r1('unique', [3, 1, 2, 1, 3])).toEqual([1, 2, 3]);
  expect(r1('unique_by(.a)', [{ a: 1 }, { a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
  expect(r1('group_by(.a)', [{ a: 1 }, { a: 2 }, { a: 1 }])).toEqual([[{ a: 1 }, { a: 1 }], [{ a: 2 }]]);
});

test('flatten / reverse', () => {
  expect(r1('flatten', [1, [2, [3]]])).toEqual([1, 2, 3]);
  expect(r1('flatten(1)', [1, [2, [3]]])).toEqual([1, 2, [3]]);
  expect(r1('reverse', [1, 2, 3])).toEqual([3, 2, 1]);
  expect(r1('reverse', 'abc')).toBe('cba');
});

test('to_entries / from_entries / with_entries', () => {
  expect(r1('to_entries', { a: 1 })).toEqual([{ key: 'a', value: 1 }]);
  expect(r1('from_entries', [{ key: 'a', value: 1 }])).toEqual({ a: 1 });
  expect(r1('with_entries(.value += 1)', { a: 1, b: 2 })).toEqual({ a: 2, b: 3 });
});

test('type / tostring / tonumber', () => {
  expect(r('type', null)).toEqual(['null']);
  expect(r1('type', [])).toBe('array');
  expect(r1('tostring', 5)).toBe('5');
  expect(r1('tostring', { a: 1 })).toBe('{"a":1}');
  expect(r1('tonumber', '42')).toBe(42);
});

test('string ops', () => {
  expect(r1('ascii_downcase', 'HELLO')).toBe('hello');
  expect(r1('ascii_upcase', 'hello')).toBe('HELLO');
  expect(r1('ltrimstr("foo")', 'foobar')).toBe('bar');
  expect(r1('rtrimstr("bar")', 'foobar')).toBe('foo');
  expect(r1('startswith("foo")', 'foobar')).toBe(true);
  expect(r1('endswith("bar")', 'foobar')).toBe(true);
  expect(r1('split(",")', 'a,b,c')).toEqual(['a', 'b', 'c']);
  expect(r1('join(",")', ['a', 'b', 'c'])).toBe('a,b,c');
  expect(r1('explode', 'AB')).toEqual([65, 66]);
  expect(r1('implode', [65, 66])).toBe('AB');
});

test('regex test/match/capture/sub/gsub', () => {
  expect(r1('test("[0-9]+")', 'abc123')).toBe(true);
  expect(r1('test("xyz")', 'abc123')).toBe(false);
  expect(r1('[match("[0-9]+"; "g")] | length', 'a1b2c3')).toBe(3);
  expect(r1('capture("(?<num>[0-9]+)")', 'abc123')).toEqual({ num: '123' });
  expect(r1('sub("[0-9]+"; "N")', 'a1b2')).toBe('aNb2');
  expect(r1('gsub("[0-9]+"; "N")', 'a1b2')).toBe('aNbN');
});

test('paths / getpath / setpath / del / delpaths', () => {
  expect(r1('getpath(["a","b"])', { a: { b: 5 } })).toBe(5);
  expect(r1('setpath(["a","b"]; 9)', { a: { b: 5 } })).toEqual({ a: { b: 9 } });
  expect(r1('del(.a)', { a: 1, b: 2 })).toEqual({ b: 2 });
  expect(r1('delpaths([["a"]])', { a: 1, b: 2 })).toEqual({ b: 2 });
  expect(r('[paths]', { a: { b: 1 } })).toEqual([[['a'], ['a', 'b']]]);
});

test('assignment operators', () => {
  expect(r1('.a = 5', { a: 1 })).toEqual({ a: 5 });
  expect(r1('.a |= . + 1', { a: 1 })).toEqual({ a: 2 });
  expect(r1('.a += 10', { a: 1 })).toEqual({ a: 11 });
  expect(r1('(.a, .b) = 0', { a: 1, b: 2 })).toEqual({ a: 0, b: 0 });
});

test('first / last / nth / limit / empty', () => {
  expect(r1('first(.[])', [1, 2, 3])).toBe(1);
  expect(r1('last(.[])', [1, 2, 3])).toBe(3);
  expect(r1('nth(1; .[])', [1, 2, 3])).toBe(2);
  expect(r('limit(2; .[])', [1, 2, 3, 4])).toEqual([1, 2]);
  expect(r('empty', null)).toEqual([]);
});

test('tojson / fromjson', () => {
  expect(r1('tojson', { a: 1 })).toBe('{"a":1}');
  expect(r1('fromjson', '{"a":1}')).toEqual({ a: 1 });
});

test('format strings', () => {
  expect(r1('@base64', 'hello')).toBe('aGVsbG8=');
  expect(r1('@base64d', 'aGVsbG8=')).toBe('hello');
  expect(r1('@json', { a: 1 })).toBe('{"a":1}');
  expect(r1('@csv', [1, 'two', 3])).toBe('1,"two",3');
  expect(r1('@tsv', ['a', 'b'])).toBe('a\tb');
  expect(r1('@uri', 'a b&c')).toBe('a%20b%26c');
  expect(r1('@html', '<a>')).toBe('&lt;a&gt;');
});

test('env / $ENV', () => {
  expect(r1('env.FOO', null, { env: { FOO: 'bar' } })).toBe('bar');
  expect(r1('$ENV.FOO', null, { env: { FOO: 'bar' } })).toBe('bar');
});

test('--arg style named args', () => {
  expect(r1('$name', null, { args: { name: 'andy' } })).toBe('andy');
});

test('recurse with filter', () => {
  expect(r('recurse(.children[]?) | .name', { name: 'a', children: [{ name: 'b' }] }))
    .toEqual(['a', 'b']);
});

test('walk', () => {
  expect(r1('walk(if type == "number" then . + 1 else . end)', { a: 1, b: [2, 3] }))
    .toEqual({ a: 2, b: [3, 4] });
});

test('error and try interplay', () => {
  expect(r('try error("x") catch ("caught: " + .)', null)).toEqual(['caught: x']);
});

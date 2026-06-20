import { expect, test } from 'vitest';
import { run } from './engine.ts';
import { formatNumber, toJSON } from './values.ts';

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
  // split/1 is LITERAL: a regex metachar splits on the literal string
  expect(r1('split(".")', 'a.b.c')).toEqual(['a', 'b', 'c']);
  expect(r1('split("x")', 'a1b22c')).toEqual(['a1b22c']);
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

test('sub/gsub replacement is a filter over the capture object', () => {
  // `.c+.c` evaluated against the named-capture object {c:"l"}
  expect(r1('sub("(?<c>l)"; .c+.c)', 'hello')).toBe('helllo');
  expect(r1('gsub("(?<c>l)"; .c+.c)', 'hello')).toBe('hellllo');
  // \( ... ) interpolation referencing captures
  expect(r1('sub("(?<x>\\\\w+)"; "[\\(.x)]")', 'hello world')).toBe('[hello] world');
  expect(r1('gsub("(?<x>.)"; .x + "!")', 'abc')).toBe('a!b!c!');
  // reorder multiple named captures
  expect(r1('sub("(?<y>\\\\d+)-(?<m>\\\\d+)-(?<d>\\\\d+)"; .m+"/"+.d+"/"+.y)', '2023-01-15')).toBe('01/15/2023');
});

test('splits/1 and split/2 split on REGEX (not literal)', () => {
  expect(r1('[splits("[0-9]+")]', 'a1b22c')).toEqual(['a', 'b', 'c']);
  // split/2 (split(re; flags)) is regex and returns an array
  expect(r1('split("[0-9]+"; "")', 'a1b22c')).toEqual(['a', 'b', 'c']);
  expect(r1('[split("[0-9]+"; "")]', 'a1b22c')).toEqual([['a', 'b', 'c']]);
  // case-insensitive regex split via flags
  expect(r1('split("X"; "i")', 'aXbxc')).toEqual(['a', 'b', 'c']);
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

test('first/last (0-arg) yield null on empty array', () => {
  expect(r('first', [])).toEqual([null]);
  expect(r('last', [])).toEqual([null]);
  expect(r1('first', [1, 2, 3])).toBe(1);
  expect(r1('last', [1, 2, 3])).toBe(3);
});

test('ascii_downcase/ascii_upcase only transform ASCII letters', () => {
  expect(r1('ascii_upcase', 'café')).toBe('CAFé');
  expect(r1('ascii_downcase', 'CAFÉ')).toBe('cafÉ');
  expect(r1('ascii_upcase', 'hello123')).toBe('HELLO123');
  expect(r1('ascii_downcase', 'HELLO123')).toBe('hello123');
  // non-ASCII is left untouched, ASCII around it still changes
  expect(r1('ascii_upcase', 'aÆb')).toBe('AÆB');
});

test('number formatting matches jq 1.7', () => {
  // integers print without a decimal point
  expect(formatNumber(3)).toBe('3');
  expect(formatNumber(3.0)).toBe('3');
  expect(formatNumber(100000)).toBe('100000');
  expect(formatNumber(-42)).toBe('-42');
  expect(formatNumber(0)).toBe('0');
  // very large / very small use exponent notation (lowercase e, signed, >=2 digits)
  expect(formatNumber(1e20)).toBe('1e+20');
  expect(formatNumber(1e100)).toBe('1e+100');
  expect(formatNumber(1.5e-10)).toBe('1.5e-10');
  // ordinary decimals print normally
  expect(formatNumber(2.5)).toBe('2.5');
  expect(formatNumber(0.1)).toBe('0.1');
  expect(formatNumber(1234567.89)).toBe('1234567.89');
  // jq 1.7: NaN renders as null; +/-Infinity clamp to the largest finite double
  expect(formatNumber(Infinity)).toBe('1.7976931348623157e+308');
  expect(formatNumber(-Infinity)).toBe('-1.7976931348623157e+308');
  expect(formatNumber(NaN)).toBe('null');
  // round-trips through JSON output
  expect(toJSON([1e20, 3.0, 1.5e-10])).toBe('[1e+20,3,1.5e-10]');
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

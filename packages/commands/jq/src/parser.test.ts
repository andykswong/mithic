import { expect, test } from 'vitest';
import { parse } from './parser.ts';

test('identity', () => {
  expect(parse('.')).toEqual({ kind: 'identity' });
});

test('field access desugars to index', () => {
  expect(parse('.foo')).toEqual({
    kind: 'index', target: { kind: 'identity' }, index: { kind: 'literal', value: 'foo' }, optional: false,
  });
});

test('chained fields', () => {
  const ast = parse('.a.b');
  expect(ast.kind).toBe('index');
  if (ast.kind === 'index') {
    expect(ast.index).toEqual({ kind: 'literal', value: 'b' });
    expect(ast.target.kind).toBe('index');
  }
});

test('pipe', () => {
  const ast = parse('.a | .b');
  expect(ast.kind).toBe('pipe');
});

test('comma', () => {
  const ast = parse('.a, .b');
  expect(ast.kind).toBe('comma');
});

test('iterate', () => {
  expect(parse('.[]').kind).toBe('iterate');
  expect(parse('.foo[]').kind).toBe('iterate');
});

test('index and slice', () => {
  expect(parse('.[0]').kind).toBe('index');
  expect(parse('.[1:3]').kind).toBe('slice');
  expect(parse('.[:3]').kind).toBe('slice');
  expect(parse('.[1:]').kind).toBe('slice');
});

test('arithmetic precedence', () => {
  const ast = parse('1 + 2 * 3');
  expect(ast.kind).toBe('binop');
  if (ast.kind === 'binop') {
    expect(ast.op).toBe('+');
    expect(ast.right.kind).toBe('binop'); // 2*3 grouped
  }
});

test('comparison and logic', () => {
  expect(parse('.a == 1').kind).toBe('binop');
  expect(parse('.a and .b').kind).toBe('and');
  expect(parse('.a or .b').kind).toBe('or');
  expect(parse('.a // .b').kind).toBe('alternative');
});

test('array and object constructors', () => {
  expect(parse('[1,2,3]').kind).toBe('array');
  expect(parse('[]').kind).toBe('array');
  const obj = parse('{a: .x, "b": .y}');
  expect(obj.kind).toBe('object');
});

test('object shorthand', () => {
  const obj = parse('{foo}');
  expect(obj.kind).toBe('object');
  if (obj.kind === 'object') {
    expect(obj.entries[0].key).toEqual({ kind: 'literal', value: 'foo' });
  }
});

test('function call with args', () => {
  const ast = parse('map(.+1)');
  expect(ast.kind).toBe('call');
  if (ast.kind === 'call') {
    expect(ast.name).toBe('map');
    expect(ast.args.length).toBe(1);
  }
});

test('if/then/else/end', () => {
  expect(parse('if . then 1 else 2 end').kind).toBe('if');
  expect(parse('if . then 1 elif .x then 2 else 3 end').kind).toBe('if');
});

test('reduce and foreach', () => {
  expect(parse('reduce .[] as $x (0; . + $x)').kind).toBe('reduce');
  expect(parse('foreach .[] as $x (0; . + $x; .)').kind).toBe('foreach');
});

test('def function', () => {
  const ast = parse('def inc: . + 1; inc');
  expect(ast.kind).toBe('funcdef');
});

test('variable binding', () => {
  const ast = parse('. as $x | $x');
  expect(ast.kind).toBe('bind');
});

test('try/catch', () => {
  expect(parse('try .a catch "err"').kind).toBe('try');
  expect(parse('try .a').kind).toBe('try');
});

test('string interpolation node', () => {
  const ast = parse('"x=\\(.a)"');
  expect(ast.kind).toBe('strinterp');
});

test('optional postfix', () => {
  expect(parse('.a?').kind).toBe('optional');
});

test('recurse default', () => {
  expect(parse('..').kind).toBe('recurseDefault');
});

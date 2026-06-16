import { expect, test } from 'vitest';
import { lex } from './lexer.ts';

const types = (src: string): string[] => lex(src).slice(0, -1).map((t) => `${t.type}:${t.value}`);

test('identity and fields', () => {
  expect(types('.')).toEqual(['PUNC:.']);
  expect(types('.foo')).toEqual(['FIELD:foo']);
  expect(types('.foo.bar')).toEqual(['FIELD:foo', 'FIELD:bar']);
});

test('recurse and pipe and comma', () => {
  expect(types('.. | .a, .b')).toEqual(['OP:..', 'PUNC:|', 'FIELD:a', 'PUNC:,', 'FIELD:b']);
});

test('numbers including float and exp', () => {
  expect(types('1 2.5 3e2 .5')).toEqual(['NUM:1', 'NUM:2.5', 'NUM:3e2', 'NUM:.5']);
});

test('operators', () => {
  expect(types('== != <= >= // + - * / %')).toEqual(
    ['OP:==', 'OP:!=', 'OP:<=', 'OP:>=', 'OP://', 'OP:+', 'OP:-', 'OP:*', 'OP:/', 'OP:%'],
  );
});

test('variables and formats', () => {
  expect(types('$x $__loc__ @base64')).toEqual(['VAR:x', 'VAR:__loc__', 'FORMAT:@base64']);
});

test('keywords and identifiers', () => {
  expect(types('if then else end def map')).toEqual(
    ['KEYWORD:if', 'KEYWORD:then', 'KEYWORD:else', 'KEYWORD:end', 'KEYWORD:def', 'IDENT:map'],
  );
  expect(types('a and b or c')).toEqual(['IDENT:a', 'OP:and', 'IDENT:b', 'OP:or', 'IDENT:c']);
});

test('plain string parts', () => {
  const t = lex('"hello"')[0];
  expect(t.type).toBe('STR');
  expect(t.parts).toEqual([{ type: 'lit', value: 'hello' }]);
});

test('string with escapes', () => {
  const t = lex('"a\\nb\\t\\u0041"')[0];
  expect(t.parts).toEqual([{ type: 'lit', value: 'a\nb\tA' }]);
});

test('string interpolation parts', () => {
  const t = lex('"x=\\(.a + 1)!"')[0];
  expect(t.parts).toEqual([
    { type: 'lit', value: 'x=' },
    { type: 'interp', src: '.a + 1' },
    { type: 'lit', value: '!' },
  ]);
});

test('comments are skipped', () => {
  expect(types('.a # comment\n.b')).toEqual(['FIELD:a', 'FIELD:b']);
});

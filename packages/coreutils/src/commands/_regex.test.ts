import { expect, test, describe } from 'vitest';
import { escapeRegExp, breToEre, compilePattern } from './_regex.ts';

describe('escapeRegExp', () => {
  test('escapes all metacharacters', () => {
    expect(escapeRegExp('a.b*c+?')).toBe('a\\.b\\*c\\+\\?');
    expect(escapeRegExp('(x)[y]{z}')).toBe('\\(x\\)\\[y\\]\\{z\\}');
    expect(escapeRegExp('a|b\\c')).toBe('a\\|b\\\\c');
  });
  test('literal match via fixed mode', () => {
    const re = compilePattern('a.c', { syntax: 'fixed' });
    expect(re.test('a.c')).toBe(true);
    expect(re.test('abc')).toBe(false);
  });
});

describe('breToEre', () => {
  test('bare + ? { } ( ) | are literal in BRE', () => {
    expect(breToEre('a+b')).toBe('a\\+b');
    expect(breToEre('a?b')).toBe('a\\?b');
    expect(breToEre('(x)')).toBe('\\(x\\)');
    expect(breToEre('a|b')).toBe('a\\|b');
  });
  test('escaped \\+ \\? \\( \\) \\| become metacharacters', () => {
    expect(breToEre('a\\+')).toBe('a+');
    expect(breToEre('\\(x\\)')).toBe('(x)');
    expect(breToEre('a\\|b')).toBe('a|b');
  });
  test('. * [ ] ^ $ pass through unchanged', () => {
    expect(breToEre('^a.*b$')).toBe('^a.*b$');
    expect(breToEre('[abc]')).toBe('[abc]');
  });
  test('bracket contents are not transformed', () => {
    expect(breToEre('[+?(]')).toBe('[+?(]');
  });
  test('other escapes pass through', () => {
    expect(breToEre('\\.\\*\\d')).toBe('\\.\\*\\d');
  });
});

describe('compilePattern', () => {
  test('BRE: bare + is literal', () => {
    expect(compilePattern('a+', { syntax: 'bre' }).test('a+')).toBe(true);
    expect(compilePattern('a+', { syntax: 'bre' }).test('aaa')).toBe(false);
  });
  test('BRE: \\+ is one-or-more', () => {
    expect(compilePattern('a\\+', { syntax: 'bre' }).test('aaa')).toBe(true);
    expect(compilePattern('a\\+', { syntax: 'bre' }).test('b')).toBe(false);
  });
  test('ERE: bare + is one-or-more', () => {
    expect(compilePattern('a+', { syntax: 'ere' }).test('aaa')).toBe(true);
  });
  test('ERE: alternation', () => {
    const re = compilePattern('foo|bar', { syntax: 'ere' });
    expect(re.test('foo')).toBe(true);
    expect(re.test('baz')).toBe(false);
  });
  test('empty pattern matches everything', () => {
    expect(compilePattern('', { syntax: 'bre' }).test('anything')).toBe(true);
    expect(compilePattern('', { syntax: 'ere' }).test('')).toBe(true);
  });
  test('ignore-case flag', () => {
    expect(compilePattern('abc', { syntax: 'ere', flags: 'i' }).test('ABC')).toBe(true);
  });
  test('invalid pattern throws', () => {
    expect(() => compilePattern('a(', { syntax: 'ere' })).toThrow();
  });
});

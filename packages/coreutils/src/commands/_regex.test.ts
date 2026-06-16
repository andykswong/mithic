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

describe('POSIX bracket classes', () => {
  test('standalone [[:digit:]]', () => {
    const re = compilePattern('[[:digit:]]', { syntax: 'bre' });
    expect(re.test('a1')).toBe(true);
    expect(re.test('abc')).toBe(false);
  });
  test('[[:alpha:]] / [[:space:]] / [[:upper:]] / [[:lower:]]', () => {
    expect(compilePattern('[[:alpha:]]', { syntax: 'ere' }).test('x')).toBe(true);
    expect(compilePattern('[[:alpha:]]', { syntax: 'ere' }).test('7')).toBe(false);
    expect(compilePattern('[[:space:]]', { syntax: 'ere' }).test('a b')).toBe(true);
    expect(compilePattern('[[:upper:]]', { syntax: 'ere' }).test('Z')).toBe(true);
    expect(compilePattern('[[:upper:]]', { syntax: 'ere' }).test('z')).toBe(false);
    expect(compilePattern('[[:lower:]]', { syntax: 'ere' }).test('z')).toBe(true);
  });
  test('[[:alnum:]] / [[:xdigit:]] / [[:punct:]] / [[:blank:]]', () => {
    expect(compilePattern('[[:alnum:]]', { syntax: 'ere' }).test('_')).toBe(false);
    expect(compilePattern('[[:alnum:]]', { syntax: 'ere' }).test('5')).toBe(true);
    expect(compilePattern('[[:xdigit:]]', { syntax: 'ere' }).test('f')).toBe(true);
    expect(compilePattern('[[:xdigit:]]', { syntax: 'ere' }).test('g')).toBe(false);
    expect(compilePattern('[[:punct:]]', { syntax: 'ere' }).test('!')).toBe(true);
    expect(compilePattern('[[:punct:]]', { syntax: 'ere' }).test('a')).toBe(false);
    expect(compilePattern('[[:blank:]]', { syntax: 'ere' }).test('\t')).toBe(true);
  });
  test('[[:cntrl:]] / [[:print:]] / [[:graph:]]', () => {
    expect(compilePattern('[[:cntrl:]]', { syntax: 'ere' }).test('\x01')).toBe(true);
    expect(compilePattern('[[:print:]]', { syntax: 'ere' }).test('A')).toBe(true);
    expect(compilePattern('[[:graph:]]', { syntax: 'ere' }).test(' ')).toBe(false);
    expect(compilePattern('[[:graph:]]', { syntax: 'ere' }).test('A')).toBe(true);
  });
  test('class inside a larger bracket expression [[:alpha:]_]', () => {
    const re = compilePattern('[[:alpha:]_]', { syntax: 'ere' });
    expect(re.test('_')).toBe(true);
    expect(re.test('a')).toBe(true);
    expect(re.test('1')).toBe(false);
  });
  test('negated class [^[:digit:]]', () => {
    const re = compilePattern('[^[:digit:]]', { syntax: 'ere' });
    expect(re.test('a')).toBe(true);
    expect(re.test('5')).toBe(false);
  });
});

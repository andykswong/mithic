import { expect, test, describe } from 'vitest';
import { tokenize } from './lexer.ts';
import type { Token } from './lexer.ts';

/** Compact a token stream to `[type, value]` pairs, dropping the trailing eof. */
function toks(src: string): Array<[string, string]> {
  return tokenize(src)
    .filter((t) => t.type !== 'eof')
    .map((t: Token) => [t.type, t.value]);
}

describe('awk lexer', () => {
  test('numbers: int, float, scientific, hex', () => {
    expect(tokenize('42').find((t) => t.type === 'num')?.num).toBe(42);
    expect(tokenize('3.14').find((t) => t.type === 'num')?.num).toBe(3.14);
    expect(tokenize('1e3').find((t) => t.type === 'num')?.num).toBe(1000);
    expect(tokenize('0xff').find((t) => t.type === 'num')?.num).toBe(255);
    expect(tokenize('.5').find((t) => t.type === 'num')?.num).toBe(0.5);
  });

  test('string with escapes decoded', () => {
    const t = tokenize('"a\\tb\\n"').find((x) => x.type === 'str')!;
    expect(t.value).toBe('a\tb\n');
  });

  test('octal escape in string', () => {
    expect(tokenize('"\\101"').find((x) => x.type === 'str')!.value).toBe('A');
  });

  test('keywords vs names vs builtins vs function calls', () => {
    expect(toks('BEGIN print x length(y) foo(z)')).toEqual([
      ['keyword', 'BEGIN'],
      ['keyword', 'print'],
      ['name', 'x'],
      ['builtin', 'length'],
      ['op', '('],
      ['name', 'y'],
      ['op', ')'],
      ['func_name', 'foo'],
      ['op', '('],
      ['name', 'z'],
      ['op', ')'],
    ]);
  });

  test('func keyword normalizes to function', () => {
    expect(toks('func f')).toEqual([['keyword', 'function'], ['name', 'f']]);
  });

  test('regex literal after operator', () => {
    const t = tokenize('$0 ~ /ab+c/');
    expect(t.find((x) => x.type === 'regex')?.value).toBe('ab+c');
  });

  test('regex literal at statement start', () => {
    expect(tokenize('/foo/').find((x) => x.type === 'regex')?.value).toBe('foo');
  });

  test('slash after value is division, not regex', () => {
    const t = toks('a / b');
    expect(t).toEqual([['name', 'a'], ['op', '/'], ['name', 'b']]);
  });

  test('slash after ) is division', () => {
    const t = toks('(a) / 2');
    expect(t.some(([ty]) => ty === 'regex')).toBe(false);
    expect(t.filter(([, v]) => v === '/').length).toBe(1);
  });

  test('regex with character class containing slash', () => {
    expect(tokenize('/[/]/').find((x) => x.type === 'regex')?.value).toBe('[/]');
  });

  test('compound and comparison operators', () => {
    expect(toks('a += 1; b == c && d')).toEqual([
      ['name', 'a'], ['op', '+='], ['num', '1'], ['op', ';'],
      ['name', 'b'], ['op', '=='], ['name', 'c'], ['op', '&&'], ['name', 'd'],
    ]);
  });

  test('** normalizes to ^', () => {
    expect(toks('2 ** 3')).toEqual([['num', '2'], ['op', '^'], ['num', '3']]);
  });

  test('increment and not-match operators', () => {
    expect(toks('i++ !~ x')).toEqual([
      ['name', 'i'], ['op', '++'], ['op', '!~'], ['name', 'x'],
    ]);
  });

  test('newlines are emitted as tokens', () => {
    const t = tokenize('a\nb');
    expect(t.filter((x) => x.type === 'newline').length).toBe(1);
  });

  test('comments are skipped', () => {
    expect(toks('a # comment\nb')).toEqual([
      ['name', 'a'], ['newline', '\n'], ['name', 'b'],
    ]);
  });

  test('line continuation absorbs newline', () => {
    const t = tokenize('a \\\nb');
    expect(t.filter((x) => x.type === 'newline').length).toBe(0);
  });

  test('field operator $', () => {
    expect(toks('$1 $NF')).toEqual([
      ['op', '$'], ['num', '1'], ['op', '$'], ['name', 'NF'],
    ]);
  });

  test('unterminated string throws', () => {
    expect(() => tokenize('"abc')).toThrow();
  });

  test('unterminated regex throws', () => {
    expect(() => tokenize('x ~ /abc')).toThrow();
  });
});

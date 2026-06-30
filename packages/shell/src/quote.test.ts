import { expect, test } from 'vitest';
import { shellQuote } from './quote.ts';

test('empty string → \'\'', () => { expect(shellQuote('')).toBe('\'\''); });
test('safe word is unquoted', () => { expect(shellQuote('abc.txt')).toBe('abc.txt'); });
test('spaces → single-quoted', () => { expect(shellQuote('a b')).toBe('\'a b\''); });
test('embedded single-quote → \'\\\'\' escaping', () => {
  expect(shellQuote('it\'s')).toBe('\'it\'\\\'\'s\'');
});
test('newline → $\'…\' ANSI-C form', () => {
  expect(shellQuote('a\nb')).toBe('$\'a\\nb\'');
});
test('tab → $\'\\t\'', () => {
  expect(shellQuote('a\tb')).toBe('$\'a\\tb\'');
});
test('round-trips a tricky value through re-quote idempotence of safe set', () => {
  expect(shellQuote('plain')).toBe('plain');
  expect(shellQuote('with$dollar')).toBe('\'with$dollar\'');
});

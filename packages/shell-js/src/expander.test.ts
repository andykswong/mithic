import { expect, test } from 'vitest';
import { Expander } from './expander.ts';

test('expands $VAR and ${VAR}', () => {
  const e = new Expander({ FOO: 'bar' });
  expect(e.expandWord('$FOO')).toEqual(['bar']);
  expect(e.expandWord('${FOO}x')).toEqual(['barx']);
});

test('unset variable expands to empty', () => {
  const e = new Expander({});
  expect(e.expandWord('$NOPE')).toEqual(['']);
});

test('double-quoted preserves spaces, single-quoted is literal', () => {
  const e = new Expander({ X: 'a b' });
  expect(e.expandWord('"$X"')).toEqual(['a b']);
  expect(e.expandWord("'$X'")).toEqual(['$X']);
});

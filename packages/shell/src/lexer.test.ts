import { expect, test } from 'vitest';
import { tokenize } from './lexer.ts';

test('tokenizes words, pipe, redirects, and quotes', () => {
  expect(tokenize('echo "hi there" | cat > out.txt').map(t => t.type)).toEqual(
    ['WORD', 'WORD', 'PIPE', 'WORD', 'GREAT', 'WORD']
  );
});

test('preserves quoted content as a single word', () => {
  const toks = tokenize('echo "a b"');
  expect(toks[1].value).toBe('a b');
});

test('recognizes $VAR and ${VAR} tokens', () => {
  expect(tokenize('echo $FOO ${BAR}').map(t => t.value)).toEqual(['echo', '$FOO', '${BAR}']);
});

test('tokenizes fd-numbered and dup redirects', () => {
  expect(tokenize('cmd 2> err').map(t => `${t.type}:${t.value}`)).toEqual(
    ['WORD:cmd', 'GREAT:2>', 'WORD:err']
  );
  expect(tokenize('cmd 2>&1').map(t => t.type)).toEqual(['WORD', 'GREATAMP', 'WORD']);
  expect(tokenize('cmd 2>&1')[1].fd).toBe(2);
  expect(tokenize('cmd &> all').map(t => t.type)).toEqual(['WORD', 'AMPGREAT', 'WORD']);
});

test('tokenizes here-string and here-doc operators', () => {
  expect(tokenize('cmd <<< word').map(t => t.type)).toEqual(['WORD', 'LESSLESSLESS', 'WORD']);
  expect(tokenize('cmd << EOF').map(t => t.type)).toEqual(['WORD', 'LESSLESS', 'WORD']);
});

test('tokenizes double-bracket, double-paren, and case ops', () => {
  expect(tokenize('[[ -f x ]]').map(t => t.type)).toEqual(['DLBRACKET', 'WORD', 'WORD', 'DRBRACKET']);
  expect(tokenize('(( x + 1 ))').map(t => t.type)).toEqual(['DLPAREN', 'WORD', 'WORD', 'WORD', 'DRPAREN']);
});

test('does not split $(...) command substitution into operator tokens', () => {
  const toks = tokenize('echo $(echo hi)');
  expect(toks.map(t => t.value)).toEqual(['echo', '$(echo hi)']);
});

test('keeps backtick substitution as one word', () => {
  const toks = tokenize('echo `echo hi`');
  expect(toks.map(t => t.value)).toEqual(['echo', '`echo hi`']);
});

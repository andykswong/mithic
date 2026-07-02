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

test('tokens carry the 1-based line they start on', () => {
  const toks = tokenize('echo a\necho b');
  const echoes = toks.filter((t) => t.value === 'echo');
  expect(echoes[0].line).toBe(1);
  expect(echoes[1].line).toBe(2);
});

test('line tracking survives a word that spans multiple lines', () => {
  const toks = tokenize('echo "line one\nline two"\necho after');
  const echoes = toks.filter((t) => t.value === 'echo');
  // The first `echo` is on line 1; the double-quoted word spans lines 1-2, so the
  // second `echo` (after the NEWLINE that follows the closing quote) is on line 3.
  expect(echoes[0].line).toBe(1);
  expect(echoes[1].line).toBe(3);
});

test('nested double-quotes inside $(...) stay one WORD', () => {
  const toks = tokenize('echo "[$(echo "a b")]"');
  expect(toks.map(t => t.type)).toEqual(['WORD', 'WORD']);
  expect(toks[1].raw).toBe('"[$(echo "a b")]"');
});

test('backslash-newline splices tokens (line continuation)', () => {
  const toks = tokenize('x=a\\\ndef');
  expect(toks.map(t => t.value)).toEqual(['x=adef']);
});

test(';& and ;;& tokenize as distinct case terminators', () => {
  expect(tokenize('a ;& b').map(t => t.type)).toEqual(['WORD', 'SEMIAMP', 'WORD']);
  expect(tokenize('a ;;& b').map(t => t.type)).toEqual(['WORD', 'SEMISEMIAMP', 'WORD']);
  expect(tokenize('a ;; b').map(t => t.type)).toEqual(['WORD', 'DSEMI', 'WORD']);
});

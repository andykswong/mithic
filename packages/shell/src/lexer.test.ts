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

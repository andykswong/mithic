/**
 * POSIX-ish shell tokenizer.
 *
 * Splits a command line into operator tokens and WORD tokens. A WORD carries two
 * representations:
 *   - `value`: quote delimiters removed (but `$VAR`/`${VAR}` preserved verbatim,
 *     since variable expansion happens later in the {@link Expander}).
 *   - `raw`: the original source text including quotes, so the executor can hand
 *     the unmodified word to the expander, which needs the quote characters to
 *     apply single/double-quote semantics.
 */

export type TokenType =
  | 'WORD'
  | 'PIPE'
  | 'GREAT'
  | 'GREATGREAT'
  | 'LESS'
  | 'AMP'
  | 'SEMI'
  | 'AND_IF'
  | 'OR_IF'
  | 'LPAREN'
  | 'RPAREN'
  | 'NEWLINE';

export interface Token {
  type: TokenType;
  /** Quote delimiters stripped; `$VAR`/`${VAR}` preserved. */
  value: string;
  /** Original source text including quotes. */
  raw: string;
}

const OPERATORS: Array<{ src: string; type: TokenType }> = [
  { src: '&&', type: 'AND_IF' },
  { src: '||', type: 'OR_IF' },
  { src: '>>', type: 'GREATGREAT' },
  { src: '|', type: 'PIPE' },
  { src: '>', type: 'GREAT' },
  { src: '<', type: 'LESS' },
  { src: '&', type: 'AMP' },
  { src: ';', type: 'SEMI' },
  { src: '(', type: 'LPAREN' },
  { src: ')', type: 'RPAREN' },
  { src: '\n', type: 'NEWLINE' },
];

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    if (isBlank(ch)) {
      i++;
      continue;
    }

    // Operators (try longest match first).
    let matchedOp = false;
    for (const op of OPERATORS) {
      if (input.startsWith(op.src, i)) {
        tokens.push({ type: op.type, value: op.src, raw: op.src });
        i += op.src.length;
        matchedOp = true;
        break;
      }
    }
    if (matchedOp) continue;

    // Otherwise accumulate a WORD until the next blank or operator.
    let value = '';
    let raw = '';
    while (i < n) {
      const c = input[i];
      if (isBlank(c)) break;
      if (isOperatorStart(input, i)) break;

      if (c === '\\') {
        // Escape: the next character is literal in both value and raw.
        const next = input[i + 1] ?? '';
        value += next;
        raw += c + next;
        i += next ? 2 : 1;
        continue;
      }

      if (c === "'") {
        // Single quotes: everything literal until the closing quote.
        const start = i;
        i++;
        let inner = '';
        while (i < n && input[i] !== "'") {
          inner += input[i];
          i++;
        }
        i++; // consume closing quote (if any)
        value += inner;
        raw += input.slice(start, i);
        continue;
      }

      if (c === '"') {
        // Double quotes: literal except escapes of " \ $ `; $VAR preserved verbatim.
        const start = i;
        i++;
        let inner = '';
        while (i < n && input[i] !== '"') {
          if (input[i] === '\\') {
            const next = input[i + 1] ?? '';
            if (next === '"' || next === '\\' || next === '$' || next === '`') {
              inner += next;
              i += 2;
              continue;
            }
            inner += '\\';
            i++;
            continue;
          }
          inner += input[i];
          i++;
        }
        i++; // consume closing quote (if any)
        value += inner;
        raw += input.slice(start, i);
        continue;
      }

      value += c;
      raw += c;
      i++;
    }

    tokens.push({ type: 'WORD', value, raw });
  }

  return tokens;
}

function isOperatorStart(input: string, i: number): boolean {
  for (const op of OPERATORS) {
    if (input.startsWith(op.src, i)) return true;
  }
  return false;
}

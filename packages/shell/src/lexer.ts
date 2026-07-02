/**
 * POSIX-ish shell tokenizer.
 *
 * Splits a command line into operator tokens and WORD tokens. A WORD carries two
 * representations:
 *   - `value`: quote delimiters removed (but `$VAR`/`${VAR}`/`$(...)`/`` `...` ``
 *     preserved verbatim, since expansion happens later in the {@link Expander}).
 *   - `raw`: the original source text including quotes, so the executor can hand
 *     the unmodified word to the expander, which needs quote characters to apply
 *     single/double-quote semantics.
 *
 * Command substitution `$(...)`, arithmetic `$((...))`, parameter `${...}`, and
 * backtick `` `...` `` are kept intact WITHIN a word (they are not split on the
 * operators they contain). The standalone `((`/`))` and `[[`/`]]` operators are
 * recognised only when not part of a `$((` substitution.
 */

export type TokenType =
  | 'WORD'
  | 'PIPE'
  | 'PIPEAMP'       // |& (pipe stdout+stderr)
  | 'GREAT'        // > or N>
  | 'GREATGREAT'   // >> or N>>
  | 'GREATPIPE'    // >| (clobber-force, overrides noclobber)
  | 'LESS'         // < or N<
  | 'LESSGREAT'    // <> or N<> (read-write)
  | 'LESSLESS'     // <<
  | 'LESSLESSDASH' // <<-
  | 'LESSLESSLESS' // <<<
  | 'GREATAMP'     // >& or N>&M (also 2>&1)
  | 'LESSAMP'      // <& or N<&M (input fd-dup)
  | 'AMPGREAT'     // &>
  | 'AMPGREATGREAT'// &>>
  | 'AMP'
  | 'SEMI'
  | 'DSEMI'        // ;;
  | 'SEMIAMP'      // ;&  (case fallthrough)
  | 'SEMISEMIAMP'  // ;;& (case continue-matching)
  | 'AND_IF'
  | 'OR_IF'
  | 'LPAREN'
  | 'RPAREN'
  | 'DLPAREN'      // ((
  | 'DRPAREN'      // ))
  | 'DLBRACKET'    // [[
  | 'DRBRACKET'    // ]]
  | 'LBRACE'       // {  (only as a standalone token)
  | 'RBRACE'       // }
  | 'NEWLINE';

export interface Token {
  type: TokenType;
  /** Quote delimiters stripped; `$VAR`/`${VAR}`/`$(...)` preserved. */
  value: string;
  /** Original source text including quotes. */
  raw: string;
  /** For redirect ops: explicit leading fd (e.g. `2>` → 2). */
  fd?: number;
  /** 1-based source line the token starts on (for $LINENO / trap ERR). */
  line: number;
}

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

/**
 * Match a glob bracket expression `[...]` starting at `input[i] === '['`,
 * returning the index just past the closing `]` (or `i` if it is not a valid
 * bracket — e.g. an unbalanced `[`). Handles `[!...]`/`[^...]`, a leading `]`
 * as a literal, and embedded POSIX classes `[[:name:]]`. A blank inside aborts
 * the bracket (so `[ -f x ]` test syntax is not swallowed).
 */
function matchBracket(input: string, i: number): number {
  const n = input.length;
  let j = i + 1;
  if (input[j] === '!' || input[j] === '^') j++;
  if (input[j] === ']') j++; // literal leading ]
  while (j < n) {
    const c = input[j];
    if (c === ']') return j + 1;
    if (c === ' ' || c === '\t' || c === '\n') return i; // not a bracket class
    if (c === '[' && input[j + 1] === ':') { const close = input.indexOf(':]', j + 2); if (close >= 0) { j = close + 2; continue; } }
    j++;
  }
  return i;
}

/**
 * Skip a `$( ... )` / `$(( ... ))` command/arithmetic substitution starting at
 * `input[i] === '$'` (with `input[i+1] === '('`), returning the index just past
 * the closing paren(s). Tracks nested parens so an inner `)` (or a nested `$(`)
 * doesn't end the group early. Used both at word top-level and INSIDE a
 * double-quoted run (so `"$(cmd "arg")"` isn't terminated by the inner quote).
 */
function skipDollarParen(input: string, i: number): number {
  const n = input.length;
  const arith = input[i + 2] === '(';
  let j = i + (arith ? 3 : 2);
  let depth = 1;
  while (j < n && depth > 0) {
    if (input[j] === '(') depth++;
    else if (input[j] === ')') depth--;
    if (depth === 0) break;
    j++;
  }
  j++; // consume closing )
  if (arith && input[j] === ')') j++; // consume second ) of ))
  return j;
}

/**
 * Match a process-substitution group `<(...)` / `>(...)` at `input[i]`,
 * returning the index past the closing `)` (or `i` if unbalanced).
 */
function procSub(input: string, i: number): number {
  const n = input.length;
  let j = i + 2;
  let depth = 1;
  while (j < n && depth > 0) {
    if (input[j] === '(') depth++;
    else if (input[j] === ')') { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return i;
}

interface OpMatch { type: TokenType; len: number; }

/** Try to match an operator at position i. Returns undefined if none. */
function matchOperator(input: string, i: number): OpMatch | undefined {
  const s = input;
  const c = s[i];
  // 3-char
  if (s.startsWith('<<<', i)) return { type: 'LESSLESSLESS', len: 3 };
  if (s.startsWith('<<-', i)) return { type: 'LESSLESSDASH', len: 3 };
  if (s.startsWith('&>>', i)) return { type: 'AMPGREATGREAT', len: 3 };
  if (s.startsWith(';;&', i)) return { type: 'SEMISEMIAMP', len: 3 };
  // 2-char
  if (s.startsWith(';&', i)) return { type: 'SEMIAMP', len: 2 };
  if (s.startsWith('&&', i)) return { type: 'AND_IF', len: 2 };
  if (s.startsWith('||', i)) return { type: 'OR_IF', len: 2 };
  if (s.startsWith('|&', i)) return { type: 'PIPEAMP', len: 2 };
  if (s.startsWith('>>', i)) return { type: 'GREATGREAT', len: 2 };
  if (s.startsWith('>|', i)) return { type: 'GREATPIPE', len: 2 };
  if (s.startsWith('<<', i)) return { type: 'LESSLESS', len: 2 };
  if (s.startsWith('<>', i)) return { type: 'LESSGREAT', len: 2 };
  if (s.startsWith('>&', i)) return { type: 'GREATAMP', len: 2 };
  if (s.startsWith('<&', i)) return { type: 'LESSAMP', len: 2 };
  if (s.startsWith('&>', i)) return { type: 'AMPGREAT', len: 2 };
  if (s.startsWith(';;', i)) return { type: 'DSEMI', len: 2 };
  if (s.startsWith('((', i)) return { type: 'DLPAREN', len: 2 };
  if (s.startsWith('))', i)) return { type: 'DRPAREN', len: 2 };
  if (s.startsWith('[[', i) && isBlank(s[i + 2] ?? ' ')) return { type: 'DLBRACKET', len: 2 };
  if (s.startsWith(']]', i)) return { type: 'DRBRACKET', len: 2 };
  // 1-char
  if (c === '|') return { type: 'PIPE', len: 1 };
  if (c === '>') return { type: 'GREAT', len: 1 };
  if (c === '<') return { type: 'LESS', len: 1 };
  if (c === '&') return { type: 'AMP', len: 1 };
  if (c === ';') return { type: 'SEMI', len: 1 };
  if (c === '(') return { type: 'LPAREN', len: 1 };
  if (c === ')') return { type: 'RPAREN', len: 1 };
  if (c === '\n') return { type: 'NEWLINE', len: 1 };
  return undefined;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  // 1-based line of the next token. `scannedUpTo` is how far we have counted
  // newlines; `lineAt(start)` advances the count to `start` (which only moves
  // forward across the scan, so this is O(n) total even though words may span
  // many lines internally).
  let line = 1;
  let scannedUpTo = 0;
  const lineAt = (start: number): number => {
    for (; scannedUpTo < start; scannedUpTo++) {
      if (input[scannedUpTo] === '\n') line++;
    }
    return line;
  };

  while (i < n) {
    const ch = input[i];

    if (isBlank(ch)) { i++; continue; }

    // Comment: `#` starting a word position runs to end of line.
    if (ch === '#' && (i === 0 || isBlank(input[i - 1]) || input[i - 1] === '\n')) {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }

    // Leading fd for a redirect: digits immediately followed by < or >.
    const fdMatch = /^(\d+)([<>])/.exec(input.slice(i));
    if (fdMatch) {
      const fd = parseInt(fdMatch[1], 10);
      const opStart = i + fdMatch[1].length;
      const op = matchOperator(input, opStart)!;
      // re-evaluate operator including the > or >> etc.
      tokens.push({ type: op.type, value: input.slice(i, opStart + op.len), raw: input.slice(i, opStart + op.len), fd, line: lineAt(i) });
      i = opStart + op.len;
      continue;
    }

    // Process substitution `<(...)` / `>(...)` at word start is a WORD, not a
    // redirect operator — handle before matchOperator would split off `<`/`>`.
    if ((ch === '<' || ch === '>') && input[i + 1] === '(') {
      const grp = procSub(input, i);
      if (grp > i) {
        // fall through into WORD accumulation starting at i (handled below)
      }
    }

    const op = matchOperator(input, i);
    if (op && !((ch === '<' || ch === '>') && input[i + 1] === '(')) {
      tokens.push({ type: op.type, value: input.slice(i, i + op.len), raw: input.slice(i, i + op.len), line: lineAt(i) });
      i += op.len;
      continue;
    }

    // Otherwise accumulate a WORD.
    const wordStart = i;
    let value = '';
    let raw = '';
    while (i < n) {
      const c = input[i];
      if (isBlank(c)) break;

      // process substitution `<(...)` / `>(...)` — keep the balanced group inside
      // the WORD so it isn't split as a redirect + subshell.
      if ((c === '<' || c === '>') && input[i + 1] === '(') {
        const grp = procSub(input, i);
        if (grp > i) { const t = input.slice(i, grp); value += t; raw += t; i = grp; continue; }
      }

      // extglob group `@(...)` `?(...)` `*(...)` `+(...)` `!(...)` — keep the
      // balanced parenthesised group inside the WORD so case/[[ ]] patterns
      // tokenize as one word (the executor decides whether extglob is enabled).
      if ('?*+@!'.includes(c) && input[i + 1] === '(') {
        const start = i;
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (input[i] === '(') depth++;
          else if (input[i] === ')') { depth--; if (depth === 0) { i++; break; } }
          i++;
        }
        const grp = input.slice(start, i);
        value += grp; raw += grp;
        continue;
      }

      // bracket class `[...]` (incl. POSIX `[[:class:]]`) — keep intact in the WORD.
      if (c === '[') {
        const end = matchBracket(input, i);
        if (end > i) { const grp = input.slice(i, end); value += grp; raw += grp; i = end; continue; }
      }

      if (matchOperator(input, i)) break;

      if (c === '\\') {
        const next = input[i + 1] ?? '';
        // Backslash-newline is a line continuation: both chars are removed so the
        // token splices across the physical line break (`a\<nl>b` → one word `ab`).
        if (next === '\n') { i += 2; continue; }
        value += next;
        raw += c + next;
        i += next ? 2 : 1;
        continue;
      }

      if (c === '\'') {
        // Single quotes: literal until closing quote. `value` drops delimiters.
        const start = i;
        i++;
        let inner = '';
        while (i < n && input[i] !== '\'') { inner += input[i]; i++; }
        i++;
        value += inner;
        raw += input.slice(start, i);
        continue;
      }

      if (c === '"') {
        // Double quotes: `value` drops delimiters but preserves $… verbatim
        // (the expander, working on raw, applies double-quote semantics).
        const start = i;
        i++;
        let inner = '';
        while (i < n && input[i] !== '"') {
          if (input[i] === '\\') {
            const next = input[i + 1] ?? '';
            // A backslash-newline inside "..." is a line continuation: both chars
            // vanish (splices the token across the physical line break).
            if (next === '\n') { i += 2; continue; }
            if (next === '"' || next === '\\' || next === '$' || next === '`') { inner += next; i += 2; continue; }
            inner += '\\'; i++; continue;
          }
          // A `$( ... )` inside the double quotes is a command/arith substitution:
          // copy it verbatim (tracking nested parens/quotes) so an inner `"` does
          // not terminate this quoted run — `"$(cmd "arg")"` is one word.
          if (input[i] === '$' && input[i + 1] === '(') {
            const end = skipDollarParen(input, i);
            inner += input.slice(i, end);
            i = end; continue;
          }
          inner += input[i];
          i++;
        }
        i++;
        value += inner;
        raw += input.slice(start, i);
        continue;
      }

      if (c === '`') {
        const start = i;
        i++;
        while (i < n && input[i] !== '`') { if (input[i] === '\\') i++; i++; }
        i++;
        value += input.slice(start, i);
        raw += input.slice(start, i);
        continue;
      }

      if (c === '$' && input[i + 1] === '\'') {
        // `$'...'` ANSI-C quoting: a `\'` does NOT close the string (unlike a plain
        // single-quote). Scan to the matching UNESCAPED `'`, keeping the body
        // verbatim in `raw` so the expander decodes the escapes.
        const start = i;
        i += 2;
        while (i < n && input[i] !== '\'') { if (input[i] === '\\' && i + 1 < n) i++; i++; }
        i++; // consume closing '
        value += input.slice(start, i);
        raw += input.slice(start, i);
        continue;
      }

      if (c === '$' && input[i + 1] === '(') {
        // $( ... ) or $(( ... )) — copy verbatim with nesting (shared helper).
        const start = i;
        i = skipDollarParen(input, i);
        value += input.slice(start, i);
        raw += input.slice(start, i);
        continue;
      }

      if (c === '$' && input[i + 1] === '{') {
        const start = i;
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (input[i] === '\\') { i += 2; continue; }
          if (input[i] === '{') depth++;
          else if (input[i] === '}') { depth--; if (depth === 0) break; }
          i++;
        }
        i++;
        value += input.slice(start, i);
        raw += input.slice(start, i);
        continue;
      }

      value += c;
      raw += c;
      i++;
    }

    tokens.push({ type: 'WORD', value, raw, line: lineAt(wordStart) });
  }

  return tokens;
}

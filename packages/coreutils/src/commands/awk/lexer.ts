/**
 * Lexer for the POSIX awk language.
 *
 * Produces a flat {@link Token} array from program source. The one genuinely
 * tricky part of awk lexing is the `/` ambiguity: `/` is division when it
 * follows a value (a number, string, name, `)`, `]`, `$`-field, or `++`/`--`
 * postfix), but starts a regex literal otherwise (after an operator, `(`, `,`,
 * `{`, `;`, a newline, or at the start). We track the previous significant
 * token to decide — exactly as awk implementations do.
 *
 * Newlines are significant in awk (they terminate statements and rules), so we
 * emit `newline` tokens rather than skipping them — except where a newline is
 * "absorbed" after tokens that cannot end a statement (e.g. after `&&`, `||`,
 * `,`, `{`, `do`, `else`, `?`, `:`), which we leave to the parser to handle by
 * also accepting an optional newline there.
 */

export type TokenType =
  | 'num' | 'str' | 'regex' | 'name' | 'func_name' | 'builtin' | 'keyword'
  | 'op' | 'newline' | 'eof';

export interface Token {
  type: TokenType;
  /** Raw text for ops/keywords/names; decoded value for str; source for regex. */
  value: string;
  /** Numeric value for `num` tokens. */
  num?: number;
  pos: number;
  line: number;
}

const KEYWORDS = new Set([
  'BEGIN', 'END', 'function', 'func',
  'if', 'else', 'while', 'for', 'do',
  'break', 'continue', 'next', 'nextfile', 'exit', 'return',
  'delete', 'in', 'getline', 'print', 'printf',
]);

const BUILTINS = new Set([
  'length', 'substr', 'index', 'split', 'sub', 'gsub', 'match',
  'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int',
  'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush',
]);

// Multi-char operators, longest first so the scanner is greedy.
const OPERATORS = [
  '+=', '-=', '*=', '/=', '%=', '^=', '**=',
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '!~', '>>', '**',
  '+', '-', '*', '/', '%', '^', '<', '>', '=', '!', '~', '?', ':',
  ';', ',', '(', ')', '{', '}', '[', ']', '$', '|',
];

function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isNameStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isNamePart(c: string): boolean { return isNameStart(c) || isDigit(c); }

/** Decode the escape sequences awk recognizes inside a double-quoted string. */
function decodeStringEscapes(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case '/': out += '/'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      default:
        if (n >= '0' && n <= '7') {
          // Octal escape: up to 3 octal digits.
          let oct = n;
          while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          // Unknown escape → keep backslash + char (awk leaves it literal).
          out += '\\' + (n ?? '');
        }
    }
  }
  return out;
}

/** Whether a `/` after `prev` begins a regex literal (vs. being division). */
function regexAllowed(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.type === 'num' || prev.type === 'str' || prev.type === 'name'
    || prev.type === 'regex' || prev.type === 'builtin') return false;
  if (prev.type === 'keyword') {
    // After value-ish keywords division can't occur, but a regex can follow
    // e.g. `print /re/`. Only postfix-y keywords would forbid it; awk has none
    // that produce a value here, so allow regex after every keyword.
    return true;
  }
  if (prev.type === 'op') {
    // Division follows a closing bracket/paren, a `$`, or postfix ++/--.
    if (prev.value === ')' || prev.value === ']' || prev.value === '++'
      || prev.value === '--') return false;
    return true;
  }
  return true;
}

/** Tokenize awk source into a token stream ending with a single `eof`. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const last = (): Token | undefined => tokens[tokens.length - 1];
  const push = (t: Omit<Token, 'line'>): void => { tokens.push({ ...t, line }); };

  while (i < n) {
    const c = src[i];

    // Line continuation: backslash-newline is whitespace.
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }

    if (c === '\n') { push({ type: 'newline', value: '\n', pos: i }); i++; line++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    // Comment to end of line.
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }

    // String literal.
    if (c === '"') {
      const start = i;
      i++;
      let raw = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') { raw += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '\n') throw new Error('newline in string');
        raw += src[i++];
      }
      if (i >= n) throw new Error('unterminated string');
      i++; // closing quote
      push({ type: 'str', value: decodeStringEscapes(raw), pos: start });
      continue;
    }

    // Regex literal vs. division.
    if (c === '/' && regexAllowed(last())) {
      const start = i;
      i++;
      let body = '';
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { body += ch + (src[i + 1] ?? ''); i += 2; continue; }
        if (ch === '\n') throw new Error('newline in regex');
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        body += ch;
        i++;
      }
      if (i >= n || src[i] !== '/') throw new Error('unterminated regex');
      i++; // closing slash
      push({ type: 'regex', value: body, pos: start });
      continue;
    }

    // Number: integer, float, scientific, hex.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(src[i])) i++;
      } else {
        while (i < n && isDigit(src[i])) i++;
        if (src[i] === '.') { i++; while (i < n && isDigit(src[i])) i++; }
        if (src[i] === 'e' || src[i] === 'E') {
          let j = i + 1;
          if (src[j] === '+' || src[j] === '-') j++;
          if (isDigit(src[j])) { i = j + 1; while (i < n && isDigit(src[i])) i++; }
        }
      }
      const text = src.slice(start, i);
      push({ type: 'num', value: text, num: Number(text), pos: start });
      continue;
    }

    // Identifier / keyword / builtin / function-call name.
    if (isNameStart(c)) {
      const start = i;
      while (i < n && isNamePart(src[i])) i++;
      const word = src.slice(start, i);
      if (KEYWORDS.has(word)) {
        push({ type: 'keyword', value: word === 'func' ? 'function' : word, pos: start });
      } else if (BUILTINS.has(word)) {
        push({ type: 'builtin', value: word, pos: start });
      } else if (src[i] === '(') {
        // A name immediately followed by `(` is a function call (no space).
        push({ type: 'func_name', value: word, pos: start });
      } else {
        push({ type: 'name', value: word, pos: start });
      }
      continue;
    }

    // Operators / punctuation.
    let matched: string | undefined;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched === undefined) throw new Error(`unexpected character ${JSON.stringify(c)}`);
    // Normalize `**` → `^` and `**=` → `^=` (awk accepts both).
    let value = matched;
    if (value === '**') value = '^';
    else if (value === '**=') value = '^=';
    push({ type: 'op', value, pos: i });
    i += matched.length;
  }

  push({ type: 'eof', value: '', pos: i });
  return tokens;
}

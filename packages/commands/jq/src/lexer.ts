/**
 * jq lexer — turns a jq program string into a flat token stream the parser
 * consumes. jq's surface syntax is small but irregular: `.foo` field access,
 * `.[`/`.]` bracket forms, `..` recurse, `//` alternative, string interpolation
 * `"\(expr)"`, `@base64` format strings, `$var`/`$__loc__`, and a fixed set of
 * keywords. Strings are tokenized into PARTS so the parser can build
 * interpolation nodes without re-scanning.
 */

/** Token kinds the lexer emits. */
export type TokenType =
  | 'NUM'
  | 'STR'
  | 'FORMAT' // @base64, @json, ...
  | 'IDENT'
  | 'FIELD' // .foo  (the bare-field shorthand; value is the field name)
  | 'VAR' // $name
  | 'KEYWORD'
  | 'OP'
  | 'PUNC'
  | 'EOF';

/**
 * A piece of a (possibly interpolated) string literal. `lit` parts are raw
 * text; `interp` parts hold the source of an embedded `\(...)` expression which
 * the parser re-lexes/parses on demand.
 */
export type StrPart = { type: 'lit'; value: string } | { type: 'interp'; src: string };

export interface Token {
  type: TokenType;
  /** Canonical text value (number text, identifier, operator, field name…). */
  value: string;
  /** For STR tokens: the decoded parts (literal + interpolation segments). */
  parts?: StrPart[];
  /** Source position (start index) for diagnostics. */
  pos: number;
}

const KEYWORDS = new Set([
  'def', 'if', 'then', 'elif', 'else', 'end', 'as', 'reduce', 'foreach',
  'try', 'catch', 'import', 'include', 'label', 'and', 'or', 'not',
  '__loc__',
]);

// Multi-char operators, longest first so the scanner is greedy.
const MULTI_OPS = ['?//', '//=', '==', '!=', '<=', '>=', '|=', '+=', '-=', '*=', '/=', '%=', '//', '..', 'and', 'or'];

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Raised on a malformed token (unterminated string, bad escape, etc.). */
export class LexError extends Error {}

/**
 * Tokenize `src` into a Token[] terminated by an EOF token. Whitespace and
 * `#` line comments are skipped. The parser drives all structure; the lexer's
 * only non-trivial work is strings (escapes + `\(...)` interpolation) and the
 * `.`-prefixed forms.
 */
export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const peek = (o = 0): string => src[i + o] ?? '';

  while (i < n) {
    const c = src[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // line comment
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }

    const start = i;

    // numbers
    if (isDigit(c) || (c === '.' && isDigit(peek(1)))) {
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.') { j++; while (j < n && isDigit(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && isDigit(src[j])) j++;
      }
      tokens.push({ type: 'NUM', value: src.slice(i, j), pos: start });
      i = j;
      continue;
    }

    // strings
    if (c === '"') {
      const { parts, end } = lexString(src, i);
      tokens.push({ type: 'STR', value: src.slice(i, end), parts, pos: start });
      i = end;
      continue;
    }

    // format strings: @base64, @json, ...
    if (c === '@') {
      let j = i + 1;
      while (j < n && isIdentChar(src[j])) j++;
      tokens.push({ type: 'FORMAT', value: src.slice(i, j), pos: start });
      i = j;
      continue;
    }

    // variables: $name, $__loc__
    if (c === '$') {
      let j = i + 1;
      while (j < n && isIdentChar(src[j])) j++;
      tokens.push({ type: 'VAR', value: src.slice(i + 1, j), pos: start });
      i = j;
      continue;
    }

    // dot forms: `..`, `.foo`, `.`, `.[`
    if (c === '.') {
      if (peek(1) === '.') { tokens.push({ type: 'OP', value: '..', pos: start }); i += 2; continue; }
      if (isIdentStart(peek(1))) {
        let j = i + 1;
        while (j < n && isIdentChar(src[j])) j++;
        tokens.push({ type: 'FIELD', value: src.slice(i + 1, j), pos: start });
        i = j;
        continue;
      }
      // lone '.' (identity) or '.[' / '."str"' handled by parser via PUNC '.'
      tokens.push({ type: 'PUNC', value: '.', pos: start });
      i++;
      continue;
    }

    // identifiers / keywords (with `::` module path support folded into ident)
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && (isIdentChar(src[j]) || (src[j] === ':' && src[j + 1] === ':'))) {
        if (src[j] === ':') j += 2; else j++;
      }
      const word = src.slice(i, j);
      if (word === 'and' || word === 'or') tokens.push({ type: 'OP', value: word, pos: start });
      else if (KEYWORDS.has(word)) tokens.push({ type: 'KEYWORD', value: word, pos: start });
      else tokens.push({ type: 'IDENT', value: word, pos: start });
      i = j;
      continue;
    }

    // multi-char operators
    let matched = false;
    for (const op of MULTI_OPS) {
      if (src.startsWith(op, i)) {
        tokens.push({ type: 'OP', value: op, pos: start });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // single-char operators and punctuation
    if ('+-*/%<>='.includes(c)) {
      tokens.push({ type: 'OP', value: c, pos: start });
      i++;
      continue;
    }
    if ('|,()[]{}:;?'.includes(c)) {
      tokens.push({ type: 'PUNC', value: c, pos: start });
      i++;
      continue;
    }

    throw new LexError(`jq: unexpected character '${c}' at position ${i}`);
  }

  tokens.push({ type: 'EOF', value: '', pos: n });
  return tokens;
}

/**
 * Scan a double-quoted string starting at `start` (the opening quote). Returns
 * the decoded {@link StrPart} list and the index just past the closing quote.
 * Handles standard JSON escapes plus jq's `\(...)` interpolation, where the
 * embedded expression source (balanced parens) is captured verbatim as an
 * `interp` part.
 */
export function lexString(src: string, start: number): { parts: StrPart[]; end: number } {
  const parts: StrPart[] = [];
  let buf = '';
  let i = start + 1;
  const n = src.length;
  const flush = (): void => { if (buf.length) { parts.push({ type: 'lit', value: buf }); buf = ''; } };

  while (i < n) {
    const c = src[i];
    if (c === '"') {
      flush();
      // ensure at least one lit part for empty strings so parser sees a string
      if (parts.length === 0) parts.push({ type: 'lit', value: '' });
      return { parts, end: i + 1 };
    }
    if (c === '\\') {
      const e = src[i + 1];
      switch (e) {
        case 'n': buf += '\n'; i += 2; break;
        case 't': buf += '\t'; i += 2; break;
        case 'r': buf += '\r'; i += 2; break;
        case 'b': buf += '\b'; i += 2; break;
        case 'f': buf += '\f'; i += 2; break;
        case '/': buf += '/'; i += 2; break;
        case '\\': buf += '\\'; i += 2; break;
        case '"': buf += '"'; i += 2; break;
        case 'u': {
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new LexError('jq: invalid \\u escape in string');
          buf += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        case '(': {
          // interpolation: capture balanced parens
          flush();
          let depth = 1;
          let j = i + 2;
          let instr = false;
          while (j < n && depth > 0) {
            const cc = src[j];
            if (instr) {
              if (cc === '\\') j++;
              else if (cc === '"') instr = false;
            } else if (cc === '"') instr = true;
            else if (cc === '(') depth++;
            else if (cc === ')') depth--;
            if (depth === 0) break;
            j++;
          }
          if (depth !== 0) throw new LexError('jq: unterminated \\(...) interpolation');
          parts.push({ type: 'interp', src: src.slice(i + 2, j) });
          i = j + 1;
          break;
        }
        default:
          throw new LexError(`jq: invalid escape '\\${e}' in string`);
      }
      continue;
    }
    buf += c;
    i++;
  }
  throw new LexError('jq: unterminated string literal');
}

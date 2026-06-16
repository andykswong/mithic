/**
 * Shared regex compilation for `grep` and `sed`.
 *
 * Both commands need to turn a POSIX-style pattern string into a JavaScript
 * `RegExp`. The translation honesty matters, so here is exactly what we do:
 *
 *   - **ERE** (`grep -E`/`egrep`, `sed -E`/`-r`): POSIX Extended Regular
 *     Expressions are, for the constructs these tools care about, a subset of
 *     JS `RegExp` syntax — `+ ? * { } ( ) |` are all metacharacters, `[...]`
 *     classes, anchors `^ $`, and the GNU extensions `\d \w \s \b` (which JS
 *     RegExp also supports). So for ERE we pass the pattern through essentially
 *     unchanged and let the JS engine compile it. This is faithful for the
 *     common cases; we do NOT implement POSIX collating classes like
 *     `[[:alpha:]]` beyond what we translate below.
 *
 *   - **BRE** (`grep` default, `sed` default): POSIX Basic Regular Expressions
 *     invert the escaping of several metacharacters relative to ERE. In BRE,
 *     `+ ? { } ( ) |` are LITERAL characters, and their special meaning is
 *     unlocked by backslash-escaping them: `\+ \? \{ \} \( \) \|`. JS RegExp is
 *     ERE-like, so we translate BRE → ERE by swapping those: an escaped
 *     `\(` becomes a group `(`, while a bare `(` becomes a literal `\(`, etc.
 *     `* . [ ] ^ $` mean the same in BRE and ERE and pass through. This covers
 *     the overwhelmingly common BRE patterns; full BRE corner cases (e.g. a `*`
 *     being literal at the start of an expression, back-reference `\1` in the
 *     pattern, `\{m,n\}` interval edge cases) are NOT fully reproduced — we lean
 *     on the JS engine for interval `{m,n}` once unescaped.
 *
 *   - **Fixed strings** (`grep -F`/`fgrep`): the pattern is a literal — we
 *     escape every regex metacharacter so it matches verbatim.
 *
 * The result is always a JS `RegExp`. Callers add flags (`i` for ignore-case,
 * `g` for global substitution) via {@link RegexMode.flags}.
 */

/** How to interpret a pattern string. */
export type RegexSyntax = 'bre' | 'ere' | 'fixed';

/** Options for {@link compilePattern}. */
export interface RegexMode {
  syntax: RegexSyntax;
  /** Extra RegExp flags to OR in, e.g. `'i'` for ignore-case, `'g'` for global. */
  flags?: string;
}

/** Escape every JS RegExp metacharacter in `s` so it matches literally. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * POSIX character-class names → the equivalent JS-RegExp bracket-interior
 * fragment. These fragments are spliced *inside* an enclosing `[...]`, so they
 * use ranges/escapes valid in a JS character class.
 */
const POSIX_CLASS: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\t\\n\\v\\f\\r ',
  blank: ' \\t',
  xdigit: '0-9A-Fa-f',
  punct: '!-/:-@\\[-`{-~',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
};

/**
 * Translate POSIX bracket classes (`[[:digit:]]` …) to JS-RegExp equivalents.
 *
 * The scan walks the pattern, tracking whether it is inside a bracket
 * expression `[...]`. A `[:name:]` token inside a bracket is replaced by its
 * mapped fragment (so both the standalone `[[:digit:]]` and the embedded
 * `[[:alpha:]_]` forms work). A `[:name:]` outside any bracket is treated as a
 * standalone class and wrapped in its own `[...]`. Unknown class names are left
 * untouched so the caller's normal compilation handles/them rejects them.
 */
export function translatePosixClasses(pattern: string): string {
  let out = '';
  let i = 0;
  let inClass = false;
  let classStart = false; // just after `[` or `[^`, where `]`/`^` are literal
  while (i < pattern.length) {
    // A `[:name:]` POSIX class token.
    if (pattern[i] === '[' && pattern[i + 1] === ':') {
      const end = pattern.indexOf(':]', i + 2);
      if (end >= 0) {
        const name = pattern.slice(i + 2, end);
        const frag = POSIX_CLASS[name];
        if (frag !== undefined) {
          out += inClass ? frag : '[' + frag + ']';
          i = end + 2;
          classStart = false;
          continue;
        }
      }
    }
    const c = pattern[i];
    if (!inClass) {
      if (c === '\\' && i + 1 < pattern.length) { out += c + pattern[i + 1]; i += 2; continue; }
      if (c === '[') { inClass = true; classStart = true; out += c; i++; continue; }
      out += c; i++; continue;
    }
    // Inside a bracket expression.
    out += c;
    if (c === '^' && classStart) { classStart = true; i++; continue; }
    if (c === ']' && !classStart) { inClass = false; }
    classStart = false;
    i++;
  }
  return out;
}

/**
 * Translate a POSIX BRE pattern to the equivalent ERE/JS source string.
 *
 * The transform walks the pattern character by character. A backslash escape of
 * one of the "special-when-escaped" metacharacters (`( ) { } + ? |`) drops the
 * backslash (so it becomes the JS metacharacter), while a bare occurrence of one
 * of those characters is escaped (so it becomes literal). Inside a bracket
 * expression `[...]` nothing is transformed — bracket contents are literal in
 * both BRE and ERE. Other backslash escapes (`\. \* \[ \d \w \s \b \1` …) are
 * passed through unchanged.
 */
export function breToEre(pattern: string): string {
  const SPECIAL_WHEN_ESCAPED = new Set(['(', ')', '{', '}', '+', '?', '|']);
  let out = '';
  let i = 0;
  let inClass = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (inClass) {
      out += c;
      if (c === ']') inClass = false;
      i++;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += c;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (SPECIAL_WHEN_ESCAPED.has(next)) {
        // `\(` → `(` etc.: escaped form is the metacharacter in BRE.
        out += next;
      } else {
        // Any other escape is passed through verbatim (`\. \* \d \1` …).
        out += '\\' + next;
      }
      i += 2;
      continue;
    }
    if (SPECIAL_WHEN_ESCAPED.has(c)) {
      // Bare metacharacter is literal in BRE → escape it for the JS engine.
      out += '\\' + c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Compile a pattern string to a JS `RegExp`, honoring {@link RegexMode}. Throws
 * the underlying `SyntaxError` if the (translated) pattern is not valid — the
 * caller is expected to catch this and emit a coreutils-style error + exit 2.
 */
export function compilePattern(pattern: string, mode: RegexMode): RegExp {
  let source: string;
  switch (mode.syntax) {
    case 'fixed':
      // Fixed strings are wholly literal — no class translation.
      source = escapeRegExp(pattern);
      break;
    case 'ere':
      source = translatePosixClasses(pattern);
      break;
    case 'bre':
      source = breToEre(translatePosixClasses(pattern));
      break;
  }
  // An empty pattern matches every line; `(?:)` is the JS empty-but-valid source.
  return new RegExp(source === '' ? '(?:)' : source, mode.flags ?? '');
}

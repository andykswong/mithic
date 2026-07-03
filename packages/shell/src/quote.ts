/**
 * Quote `s` so it re-inputs to the shell as the exact same string — the engine
 * behind `printf %q`. Mirrors bash: a value of only safe chars is left bare; a
 * value with newline/tab/other control chars uses the ANSI-C `$'…'` form; anything
 * else is single-quoted with embedded `'` written as `'\''`.
 *
 * NOTE: `printf %q` leaves a safe word BARE, but `${var@Q}` ALWAYS quotes it (bash
 * 5: `${v@Q}` of `abc` → `'abc'`). Use {@link shellQuoteQ} for the `@Q`/`@K`/`@k`/
 * `@A` transforms; this function backs `printf %q` (safe words stay bare).
 */
const SAFE = /^[A-Za-z0-9_./:=@%+,-]+$/;
const CTRL = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex

/**
 * Emit the ANSI-C `$'…'` form for a value containing control characters, matching
 * bash's escape choices: NAMED escapes for the common control chars (`\a \b \t \n
 * \v \f \r \E`), OCTAL `\NNN` (3-digit) for every other control byte incl. 0x7f,
 * and `\\` / `\'` for backslash / single-quote.
 */
function ansiCQuote(s: string): string {
  const named: Record<number, string> = {
    0x07: '\\a', 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n',
    0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r', 0x1b: '\\E',
  };
  let out = '$\'';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '\'') out += '\\\'';
    else if (named[c] !== undefined) out += named[c];
    else if (c < 0x20 || c === 0x7f) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + '\'';
}

/**
 * Single-quote `s` with embedded `'` written as `'\''`, EXCEPT a value that is
 * exactly one single-quote, which bash renders as the backslash form `\'` (both in
 * `printf %q` and `${var@Q}`).
 */
function singleQuote(s: string): string {
  if (s === '\'') return '\\\'';
  return '\'' + s.replace(/'/g, '\'\\\'\'') + '\'';
}

export function shellQuote(s: string): string {
  if (s === '') return '\'\'';
  if (SAFE.test(s)) return s;
  if (CTRL.test(s)) return ansiCQuote(s);
  return singleQuote(s);
}

/**
 * Quote `s` for the `${var@Q}` / `@K` / `@k` / `@A` transforms. Unlike
 * {@link shellQuote} (`printf %q`), bash's `@Q` ALWAYS single-quotes a value, even a
 * safe word (`${v@Q}` of `abc` → `'abc'`; of `''` → `''`). A value with control
 * chars still uses the ANSI-C `$'…'` form; a lone `'` uses the `\'` backslash form.
 */
export function shellQuoteQ(s: string): string {
  if (s === '') return '\'\'';
  if (CTRL.test(s)) return ansiCQuote(s);
  return singleQuote(s);
}

/**
 * Quote `s` for safe shell re-input using bash `printf %q` BACKSLASH style
 * (distinct from {@link shellQuote}'s single-quote style — both re-input
 * identically). Empty → `''`. A char outside the safe set is backslash-escaped;
 * control chars use the ANSI-C `$'…'` form (reusing {@link shellQuote}'s path).
 */
export function shellQuoteBackslash(s: string): string {
  if (s === '') return '\'\'';
  if (CTRL.test(s)) return shellQuote(s); // control chars → reuse $'…' path
  if (SAFE.test(s)) return s; // safe charset stays bare
  return s.replace(/[^A-Za-z0-9_./:=@%+,-]/g, (c) => '\\' + c);
}

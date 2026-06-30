/**
 * Quote `s` so it re-inputs to the shell as the exact same string — the engine
 * behind `printf %q` and `${var@Q}`. Mirrors bash: a value of only safe chars is
 * left bare; a value with newline/tab/other control chars uses the ANSI-C `$'…'`
 * form; anything else is single-quoted with embedded `'` written as `'\''`.
 */
const SAFE = /^[A-Za-z0-9_./:=@%+,-]+$/;
const CTRL = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex

export function shellQuote(s: string): string {
  if (s === '') return '\'\'';
  if (SAFE.test(s)) return s;
  if (CTRL.test(s)) {
    let out = '$\'';
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\'') out += '\\\'';
      else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
      else out += ch;
    }
    return out + '\'';
  }
  return '\'' + s.replace(/'/g, '\'\\\'\'') + '\'';
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

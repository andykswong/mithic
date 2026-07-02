/**
 * Interpret backslash escapes. When `octalBackslashZero` is true (printf format
 * strings), octal is written `\0nnn`; for `%b` arguments it is `\nnn`.
 *
 * `ansiC` selects true ANSI-C (`$'…'` / `${var@E}`) semantics — where `\'` → `'`.
 * printf's format string and `%b` argument keep `\'` literal, so they pass false.
 *
 * Shared by `printf` (builtins.ts) and the `$'…'` / `${var@E}` expansions
 * (expander.ts).
 */
export function interpretEscapes(s: string, octalBackslashZero: boolean, ansiC = false): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '\\') { out += s[i]; i++; continue; }
    const next = s[i + 1];
    switch (next) {
      case 'n': out += '\n'; i += 2; continue;
      case 't': out += '\t'; i += 2; continue;
      case 'r': out += '\r'; i += 2; continue;
      case 'a': out += '\x07'; i += 2; continue;
      case 'e': out += '\x1b'; i += 2; continue;
      case 'b': out += '\b'; i += 2; continue;
      case 'f': out += '\f'; i += 2; continue;
      case 'v': out += '\v'; i += 2; continue;
      case '\\': out += '\\'; i += 2; continue;
      case '"': out += '"'; i += 2; continue;
      // `\'` is an escape ONLY in ANSI-C contexts (`$'…'`, `${var@E}`); printf's
      // format / `%b` keep it literal (bash).
      case '\'': if (ansiC) { out += '\''; i += 2; continue; } break;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2));
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
        out += '\\x'; i += 2; continue;
      }
      default: break;
    }
    // Octal in a printf FORMAT: `\0nnn` (1–3 octal digits after the 0) or, as a
    // GNU extension, a bare `\nnn`.
    if (octalBackslashZero && next === '0') {
      const m = /^[0-7]{1,3}/.exec(s.slice(i + 2));
      const oct = m ? m[0] : '';
      out += String.fromCharCode(parseInt(oct || '0', 8));
      i += 2 + oct.length; continue;
    }
    // Octal in a `%b` argument: `\nnn` (and `\0nnn`). Also bare `\nnn` in formats.
    if (/[0-7]/.test(next ?? '')) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i + 1));
      const oct = m ? m[0] : '0';
      out += String.fromCharCode(parseInt(oct, 8));
      i += 1 + oct.length; continue;
    }
    // Unknown escape: keep the backslash literally.
    out += '\\'; i += 1;
  }
  return out;
}

/**
 * Bash-style `PS1` prompt expansion — a small, pure helper that renders the
 * common prompt escapes a `.bashrc` uses. Kept independent of the executor so
 * front-ends (e.g. the example terminal) can compute the prompt each REPL turn
 * from the live `cwd` + `env`.
 *
 * Supported escapes (the subset the example's PS1 relies on):
 *   \w  — cwd, with a leading `$HOME` collapsed to `~`
 *   \W  — basename of cwd (`/` for the root)
 *   \u  — `$USER` (falls back to `user`)
 *   \h  — short hostname: `$HOSTNAME` (falls back to `mithic`)
 *   \$  — a literal `$` (no uid distinction in this sandbox)
 *   \e, \033 — ESC (0x1b);  \a — BEL (0x07)
 *   \n, \r, \\ — newline / carriage-return / backslash
 */
export interface PromptContext {
  cwd: string;
  env: Record<string, string>;
}

/** Collapse a leading `$HOME` in `cwd` to `~` (bash `\w`). */
function collapseHome(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  if (cwd === home) return '~';
  // A path is "under" HOME only when it begins with `HOME + '/'`. Normalizing
  // HOME's trailing slash away first means HOME=`/` collapses only `/` itself
  // (not `/tmp` → `~tmp`, which the naive prefix check would produce).
  const base = home.replace(/\/+$/, '');
  if (base !== '' && cwd.startsWith(`${base}/`)) {
    return '~' + cwd.slice(base.length);
  }
  return cwd;
}

/** Basename of a path (`/` for the root). */
function basename(cwd: string): string {
  if (cwd === '/' || cwd === '') return '/';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '/';
}

export function expandPrompt(ps1: string, ctx: PromptContext): string {
  let out = '';
  for (let i = 0; i < ps1.length; i++) {
    const c = ps1[i];
    if (c !== '\\') { out += c; continue; }
    const next = ps1[i + 1];
    // `\033` (octal ESC) is the only multi-char numeric escape the prompt uses.
    if (ps1.startsWith('033', i + 1)) { out += '\x1b'; i += 3; continue; }
    switch (next) {
      case 'w': out += collapseHome(ctx.cwd, ctx.env.HOME); i++; continue;
      case 'W': out += basename(ctx.cwd); i++; continue;
      case 'u': out += ctx.env.USER || 'user'; i++; continue;
      case 'h': out += (ctx.env.HOSTNAME || 'mithic').split('.')[0]; i++; continue;
      case '$': out += '$'; i++; continue;
      case 'e': out += '\x1b'; i++; continue;
      case 'a': out += '\x07'; i++; continue;
      case 'n': out += '\n'; i++; continue;
      case 'r': out += '\r'; i++; continue;
      case '\\': out += '\\'; i++; continue;
      default:
        // Unknown escape: keep the backslash + char literally (bash-ish).
        out += '\\';
        continue;
    }
  }
  return out;
}

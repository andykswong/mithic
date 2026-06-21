/**
 * Unified glob → RegExp compiler (M12, SE-DRY fix).
 *
 * Previously the expander (pathname expansion) and executor (case/`[[ ]]`
 * matching) each carried a separate, slightly-divergent glob compiler. This
 * single module replaces both. It supports:
 *   - `*` `?` and bracket classes `[abc]` / `[!abc]` / `[a-z]`,
 *   - POSIX character classes `[[:digit:]]`, `[[:alpha:]]`, … inside brackets,
 *   - extglob `@(p|q)` `?(…)` `*(…)` `+(…)` `!(…)` (gated by `extglob`),
 *   - globstar `**` matching across `/` (gated by `globstar`, segment-level).
 *
 * `globToReSource` returns a regex SOURCE fragment (no anchors) so callers can
 * compose it. `globMatch` anchors and tests a whole string.
 */

export interface GlobOptions {
  /** Enable extglob `@()/?()/*()/+()/!()` operators. */
  extglob?: boolean;
  /** Case-insensitive matching (nocaseglob / nocasematch). */
  nocase?: boolean;
  /**
   * Pathname-segment mode: `*`/`?` do NOT cross `/` (default true for pathname
   * expansion). String-matching contexts — `case`, `[[ ]]`, and `${var#pat}`
   * parameter expansion — pass `false`, where `*` matches across `/` too.
   */
  pathSegment?: boolean;
}

const POSIX_CLASSES: Record<string, string> = {
  digit: '0-9',
  alpha: 'A-Za-z',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\r\\n\\f\\v',
  blank: ' \\t',
  punct: '!-/:-@\\[-`{-~',
  print: ' -~',
  graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
};

function escapeRe(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c;
}

/** Compile a glob pattern to a RegExp source fragment (no anchors). */
export function globToReSource(pat: string, opts: GlobOptions = {}): string {
  let re = '';
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];

    if (c === '\\') { re += escapeRe(pat[i + 1] ?? ''); i += 2; continue; }

    // extglob operators: X(p1|p2|...)
    if (opts.extglob && '?*+@!'.includes(c) && pat[i + 1] === '(') {
      const end = findMatchingParen(pat, i + 2);
      const inner = pat.slice(i + 2, end);
      const alts = splitAlts(inner).map((a) => globToReSource(a, opts));
      const group = '(?:' + alts.join('|') + ')';
      if (c === '!') {
        // Negation `!(pat)` matches a span that is NOT matched by `pat`. To stay
        // correct when embedded mid-pattern (e.g. `x!(foo)y`) we compile the
        // *suffix* (rest of the pattern) here and emit
        //   (?!(?:pat)(?:suffix)$) [anychar]* (?:suffix)
        // The leading negative lookahead, anchored at the start of the negated
        // span and tempered by the suffix, rejects exactly the splits where
        // `pat` would cover the negated portion (this also makes `!()` exclude
        // only the empty string). The greedy run then consumes the negated span
        // and the suffix matches the rest. The old code anchored the lookahead
        // to `$`, which only happened to be correct when `!()` was the whole
        // pattern (R1).
        const dot = (opts.pathSegment !== false) ? '[^/]' : '[\\s\\S]';
        const suffix = globToReSource(pat.slice(end + 1), opts);
        re += '(?!' + group + suffix + '$)' + dot + '*' + suffix;
        return re; // suffix already consumed
      }
      switch (c) {
        case '?': re += group + '?'; break;
        case '*': re += group + '*'; break;
        case '+': re += group + '+'; break;
        case '@': re += group; break;
      }
      i = end + 1;
      continue;
    }

    const seg = opts.pathSegment !== false;
    if (c === '*') {
      // `**` always crosses `/` (globstar); a single `*` crosses `/` only outside
      // pathname-segment mode (string matching in case/[[ ]]/${var#pat}).
      if (pat[i + 1] === '*') { re += '.*'; i += 2; continue; }
      re += seg ? '[^/]*' : '.*';
      i++;
      continue;
    }
    if (c === '?') { re += seg ? '[^/]' : '.'; i++; continue; }

    if (c === '[') {
      const compiled = compileBracket(pat, i);
      if (compiled) { re += compiled.re; i = compiled.next; continue; }
      re += '\\['; i++; continue;
    }

    re += escapeRe(c); i++;
  }
  return re;
}

/** Compile a `[...]` bracket expression (with POSIX classes). Returns undefined if unterminated. */
function compileBracket(pat: string, start: number): { re: string; next: number } | undefined {
  let j = start + 1;
  let neg = false;
  if (pat[j] === '!' || pat[j] === '^') { neg = true; j++; }
  let cls = '';
  // A `]` immediately after `[`/`[^` is a literal `]`.
  if (pat[j] === ']') { cls += '\\]'; j++; }
  while (j < pat.length && pat[j] !== ']') {
    // POSIX class [:name:]
    if (pat[j] === '[' && pat[j + 1] === ':') {
      const close = pat.indexOf(':]', j + 2);
      if (close >= 0) {
        const name = pat.slice(j + 2, close);
        const range = POSIX_CLASSES[name];
        if (range !== undefined) { cls += range; j = close + 2; continue; }
      }
    }
    const ch = pat[j];
    cls += ch === '\\' ? '\\\\' : (/[\]^]/.test(ch) ? '\\' + ch : ch);
    j++;
  }
  if (j >= pat.length) return undefined; // unterminated
  return { re: '[' + (neg ? '^' : '') + cls + ']', next: j + 1 };
}

/** Split extglob alternatives on top-level `|`. */
function splitAlts(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function findMatchingParen(s: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return s.length;
}

/** Build an anchored RegExp from a glob pattern. */
export function globToRegExp(pat: string, opts: GlobOptions = {}): RegExp {
  return new RegExp('^' + globToReSource(pat, opts) + '$', opts.nocase ? 's' + 'i' : 's');
}

/** Match a glob pattern against a whole string. */
export function globMatch(value: string, pattern: string, opts: GlobOptions = {}): boolean {
  try { return globToRegExp(pattern, opts).test(value); }
  catch { return value === pattern; }
}

/** True when a pattern contains any glob metacharacter (incl. extglob when enabled). */
export function isGlobPattern(s: string, extglob = false): boolean {
  if (/[*?[]/.test(s)) return true;
  if (extglob && /[?*+@!]\(/.test(s)) return true;
  return false;
}

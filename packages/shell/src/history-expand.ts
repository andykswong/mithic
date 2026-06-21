/**
 * History expansion (M13) — the interactive `!`-event reference stage that bash
 * runs on each input line BEFORE parsing, when `histexpand` (`set -H`) is on.
 *
 * Supported event designators (the common ones real scripts/users rely on):
 *   - `!!`        — the previous command
 *   - `!n`        — history entry n (1-based, as shown by `history`)
 *   - `!-n`       — the n-th command back from the end
 *   - `!string`   — the most recent command starting with `string`
 *   - `!?string?` — the most recent command containing `string`
 *
 * Not supported (left literal): word designators (`!!:1`), modifiers (`:s/…/…/`),
 * and `!#`. A `!` that is not a recognized event is left untouched UNLESS it
 * clearly looks like an event reference, in which case "event not found" is
 * raised — matching bash, which aborts the line on an unresolved `!ref`.
 *
 * Quoting: a `!` inside single quotes is literal. Inside double quotes bash
 * still performs history expansion, so we only suppress within single quotes.
 * A `!` followed by whitespace, `=`, or `(` is not an event (covers `[ ! x ]`,
 * `!=`, and `!(extglob)`).
 */

export class HistoryEventNotFound extends Error {
  readonly token: string;
  constructor(token: string) {
    super(`${token}: event not found`);
    this.name = 'HistoryEventNotFound';
    this.token = token;
  }
}

/**
 * Expand history event references in a single physical input line.
 *
 * @param line     the raw input line
 * @param history  command history, most-recent-LAST (as `history` lists it)
 * @returns the line with `!`-events substituted
 * @throws {HistoryEventNotFound} when a `!ref` cannot be resolved
 */
export function expandHistory(line: string, history: readonly string[]): string {
  if (!line.includes('!')) return line;

  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < line.length) {
    const c = line[i];

    if (c === '\\' && !inSingle) {
      // Backslash escapes the next char (a `\!` is a literal `!`).
      out += c + (line[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === '\'' && !inDouble) { inSingle = !inSingle; out += c; i++; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; out += c; i++; continue; }

    if (c === '!' && !inSingle) {
      const next = line[i + 1];
      const prev = line[i - 1];
      // `!` at end of line, or followed by whitespace / `=` / `(` is literal.
      // A `!` immediately preceded by `$` or `{` is a parameter ref (`$!`,
      // `${!x}`), not a history event. (bash protects these.)
      if (next === undefined || next === ' ' || next === '\t' || next === '=' || next === '('
        || prev === '$' || prev === '{') {
        out += c; i++; continue;
      }
      const ev = parseEvent(line, i);
      const resolved = resolveEvent(ev.designator, history);
      if (resolved === undefined) throw new HistoryEventNotFound(line.slice(i, ev.next));
      out += resolved;
      i = ev.next;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/** Parse a `!`-event token starting at `line[start]` (the `!`). */
function parseEvent(line: string, start: number): { designator: string; next: number } {
  let j = start + 1;
  if (line[j] === '!') return { designator: '!!', next: j + 1 };

  // `!?string?` — search for a substring, terminated by `?` or end.
  if (line[j] === '?') {
    j++;
    const close = line.indexOf('?', j);
    const term = close >= 0 ? close : line.length;
    const str = line.slice(j, term);
    return { designator: '?' + str, next: close >= 0 ? close + 1 : term };
  }

  // `!-n` or `!n` (numeric), or `!string` (prefix match — letters/digits/_-/.).
  if (line[j] === '-') {
    let k = j + 1;
    while (k < line.length && /[0-9]/.test(line[k]!)) k++;
    return { designator: line.slice(start + 1, k), next: k };
  }
  if (/[0-9]/.test(line[j] ?? '')) {
    let k = j;
    while (k < line.length && /[0-9]/.test(line[k]!)) k++;
    return { designator: line.slice(start + 1, k), next: k };
  }
  // prefix string: consume word chars (stop at shell metachars / whitespace)
  let k = j;
  while (k < line.length && !/[\s'"`;&|<>()$!]/.test(line[k]!)) k++;
  return { designator: line.slice(start + 1, k), next: k };
}

/** Resolve a parsed designator against history (most-recent-last). */
function resolveEvent(designator: string, history: readonly string[]): string | undefined {
  if (history.length === 0) return undefined;

  if (designator === '!!') return history[history.length - 1]; // `!!`

  // `?string` — most recent command containing string.
  if (designator.startsWith('?')) {
    const needle = designator.slice(1);
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.includes(needle)) return history[i];
    }
    return undefined;
  }

  // `-n` — n-th from the end.
  if (designator.startsWith('-')) {
    const n = parseInt(designator.slice(1), 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const idx = history.length - n;
    return idx >= 0 ? history[idx] : undefined;
  }

  // `n` — 1-based absolute index into history.
  if (/^[0-9]+$/.test(designator)) {
    const n = parseInt(designator, 10);
    return n >= 1 && n <= history.length ? history[n - 1] : undefined;
  }

  // `string` — most recent command starting with string.
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.startsWith(designator)) return history[i];
  }
  return undefined;
}

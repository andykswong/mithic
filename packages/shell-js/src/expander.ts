/**
 * Word expander: variable substitution + quote removal + word splitting.
 *
 * Operates on the RAW word source (quote characters intact), so it can apply
 * single/double-quote semantics:
 *   - single quotes  → fully literal (no expansion).
 *   - double quotes  → `$VAR`/`${VAR}` expand; the result is NOT word-split.
 *   - unquoted        → `$VAR`/`${VAR}` expand; the result IS word-split on IFS
 *                       whitespace (a field is emitted even for an empty result
 *                       when no other content joins it).
 *
 * Glob and brace expansion are deferred (see Task J.8).
 */
export class Expander {
  private env: Record<string, string>;

  constructor(env: Record<string, string>) {
    this.env = env;
  }

  /** Expand a single raw word into zero or more fields. */
  expandWord(word: string): string[] {
    // Build a list of "parts": each part is a run of characters tagged with
    // whether it is subject to word splitting (unquoted) or not (quoted).
    type Part = { text: string; split: boolean };
    const parts: Part[] = [];
    const pushSplit = (text: string): void => { if (text) parts.push({ text, split: true }); };
    const pushQuoted = (text: string): void => { parts.push({ text, split: false }); };

    let i = 0;
    const n = word.length;
    let pending = ''; // accumulating unquoted (splittable) text

    const flushPending = (): void => { pushSplit(pending); pending = ''; };

    while (i < n) {
      const c = word[i];

      if (c === '\\') {
        pending += word[i + 1] ?? '';
        i += word[i + 1] !== undefined ? 2 : 1;
        continue;
      }

      if (c === '\'') {
        // Single-quoted: literal until closing quote, not split.
        flushPending();
        i++;
        let inner = '';
        while (i < n && word[i] !== '\'') { inner += word[i]; i++; }
        i++;
        pushQuoted(inner);
        continue;
      }

      if (c === '"') {
        // Double-quoted: expand $ but do not split.
        flushPending();
        i++;
        let inner = '';
        while (i < n && word[i] !== '"') {
          if (word[i] === '\\') {
            const next = word[i + 1] ?? '';
            if (next === '"' || next === '\\' || next === '$' || next === '`') {
              inner += next;
              i += 2;
              continue;
            }
            inner += '\\';
            i++;
            continue;
          }
          if (word[i] === '$') {
            const { value, next } = this.readVariable(word, i);
            inner += value;
            i = next;
            continue;
          }
          inner += word[i];
          i++;
        }
        i++;
        pushQuoted(inner);
        continue;
      }

      if (c === '$') {
        const { value, next } = this.readVariable(word, i);
        pending += value;
        i = next;
        continue;
      }

      pending += c;
      i++;
    }
    flushPending();

    return this.splitParts(parts);
  }

  /** Expand a word to a single joined string (no word splitting). Used for assignments / redirect targets. */
  expandToString(word: string): string {
    const fields = this.expandWord(word);
    return fields.join(' ');
  }

  /**
   * Read a `$VAR` or `${VAR}` reference starting at `word[i] === '$'`.
   * Returns the substituted value and the index just past the reference.
   */
  private readVariable(word: string, i: number): { value: string; next: number } {
    const n = word.length;
    let j = i + 1;
    if (word[j] === '{') {
      j++;
      let name = '';
      while (j < n && word[j] !== '}') { name += word[j]; j++; }
      j++; // consume '}'
      return { value: this.env[name] ?? '', next: j };
    }
    // $NAME — name is [A-Za-z_][A-Za-z0-9_]*. A bare `$` is literal.
    let name = '';
    while (j < n && /[A-Za-z0-9_]/.test(word[j])) {
      if (name === '' && /[0-9]/.test(word[j])) break; // names don't start with a digit
      name += word[j];
      j++;
    }
    if (name === '') {
      return { value: '$', next: i + 1 };
    }
    return { value: this.env[name] ?? '', next: j };
  }

  /**
   * Join parts and split unquoted (`split: true`) regions on IFS whitespace.
   * Quoted regions are kept verbatim and glue to adjacent fields. If the whole
   * word produced no fields, a single empty field is returned (matching the
   * unset-unquoted behavior expected by the spec).
   */
  private splitParts(parts: Array<{ text: string; split: boolean }>): string[] {
    const fields: string[] = [];
    let current = '';
    let started = false;

    for (const part of parts) {
      if (!part.split) {
        current += part.text;
        started = true;
        continue;
      }
      // Splittable region: break on runs of whitespace.
      let k = 0;
      const t = part.text;
      while (k < t.length) {
        if (/\s/.test(t[k])) {
          // End the current field (if any content) and skip the whitespace run.
          if (started) { fields.push(current); current = ''; started = false; }
          while (k < t.length && /\s/.test(t[k])) k++;
        } else {
          current += t[k];
          started = true;
          k++;
        }
      }
    }
    if (started) fields.push(current);

    return fields.length > 0 ? fields : [''];
  }
}

/**
 * Word expander: brace → tilde → parameter/command/arithmetic substitution →
 * word splitting → pathname (glob) expansion, with quote removal.
 *
 * The expander is ASYNC because two stages reach outside pure string logic:
 *   - command substitution `$(cmd)` / `` `cmd` `` runs a subcommand (via the
 *     executor, threaded in as {@link ShellEnv.runCommandSub}); and
 *   - pathname expansion (glob) lists the VFS (via {@link ShellEnv.listDir}).
 *
 * Quote semantics:
 *   - single quotes  → fully literal (no expansion).
 *   - double quotes  → `$…`/`$(…)`/`` `…` `` expand; result is NOT word-split or
 *                       glob-expanded.
 *   - unquoted        → expand, word-split on IFS whitespace, then glob.
 *
 * Bash expansion ORDER: brace expansion happens first (before variables), so
 * `{$V,b}` splits on the literal braces and only then expands `$V` in each arm.
 */
import { evalArith } from './arith.ts';
import { globToReSource, globToRegExp, isGlobPattern } from './glob.ts';
import type { GlobOptions } from './glob.ts';
import { shellQuote } from './quote.ts';
import { interpretEscapes } from './escape.ts';

/**
 * The shell-state surface the expander reads/writes. Implemented by the
 * executor (which owns the live env, positional params, last status, and the
 * kernel/VFS access). Decoupled as an interface so the expander is unit-testable
 * with a plain mock.
 */
export interface ShellEnv {
  /** Read a named variable (returns undefined when unset). */
  get(name: string): string | undefined;
  /** Write a named variable (used by `${var:=default}`). */
  set(name: string, value: string): void;
  /** True when the variable is set (even to empty). */
  has(name: string): boolean;
  /**
   * Resolve a special parameter: `?` `#` `@` `*` `$` `!` `0` and positionals
   * `1`..`N`. Returns undefined for names this env does not recognise.
   * For `@`/`*` the joined string is returned (callers needing array semantics
   * use {@link getPositional}).
   */
  getSpecial(name: string): string | undefined;
  /** Positional params as an array, for `$@`/`$*` field expansion. Optional. */
  getPositional?(): string[];
  /** Run a command-substitution body and return its captured stdout. */
  runCommandSub(src: string): Promise<string>;
  /** List a directory's entries for glob expansion; undefined ⇒ not a dir. */
  listDir(path: string): Promise<string[] | undefined>;
  /** Stat a path for glob (returns kind), undefined ⇒ does not exist. Optional. */
  statPath?(path: string): Promise<{ dir: boolean } | undefined>;
  /** Current working directory, for relative glob resolution. Optional. */
  cwd?: string;
  /** True when `set -u` is active: expanding an unset variable is an error. */
  nounset?(): boolean;
  /** Read an indexed array's elements (undefined ⇒ not an array). Optional. */
  getArray?(name: string): string[] | undefined;
  /** Read an associative array's map (undefined ⇒ not associative). Optional. */
  getAssoc?(name: string): Map<string, string> | undefined;
  /** True when POSIX mode is active (disables brace expansion). Optional. */
  posix?(): boolean;
  /** True when the named shopt glob option is enabled (extglob/globstar/nullglob/dotglob/...). */
  shopt?(name: string): boolean;
  /** All currently-set variable names, for `${!prefix*}` / `${!prefix@}`. Optional. */
  names?(): string[];
  /**
   * Attribute flags of a variable for `${var@a}`: `r` readonly, `n` nameref,
   * `a` indexed array, `A` associative array; a plain scalar → `''`. Optional.
   */
  attrFlags?(name: string): string;
  /**
   * Process substitution `<(cmd)` / `>(cmd)`: run `cmd` and return a VFS path the
   * surrounding command reads (`dir: 'in'`) or writes (`dir: 'out'`). Optional —
   * undefined ⇒ the construct is left literal.
   */
  procSub?(src: string, dir: 'in' | 'out'): Promise<string>;
}

/**
 * Thrown by the expander for a fatal expansion error — `set -u` on an unset
 * variable, or `${var:?msg}` on a null/unset variable. The executor catches it,
 * writes the message to stderr, and aborts the script with a nonzero status.
 */
export class ExpansionError extends Error {}

/**
 * A fragment of a word after substitution. `quoted` text is never word-split or
 * glob-expanded. A `fieldBreak` part is a zero-width hard field boundary emitted
 * between the elements of a `$@` / `${arr[@]}` expansion: it forces the field on
 * its left to close even when adjacent (quoted) text would otherwise join — this
 * is what gives `"pre$@post"` its bash boundary semantics (`prea`, `b`, `cpost`).
 */
type Part = { text: string; quoted: boolean; fieldBreak?: false } | { fieldBreak: true };

/**
 * Result of reading one `$…` / `${…}` construct. Either a single `value`, or a
 * multi-element expansion (`fields`) for the `@`/`*`-forms. For `fields`, `join`
 * is the IFS-join character when the form is `*` (one field), or undefined when
 * the form is `@` (one field per element).
 */
type DollarResult =
  | { value: string; next: number; fields?: undefined }
  | { fields: string[]; join: string | undefined; next: number; value?: undefined };

export class Expander {
  private env: ShellEnv;

  constructor(env: ShellEnv) {
    this.env = env;
  }

  /** Expand a single raw word into zero or more fields. */
  async expandWord(word: string): Promise<string[]> {
    // 1. Brace expansion (purely textual, pre-substitution). Disabled in POSIX mode.
    const braced = this.env.posix?.() ? [word] : expandBraces(word);
    const out: string[] = [];
    let anyEmptyByAt = false;
    let nullglobbed = false;
    for (const braw of braced) {
      // 2. tilde expansion (leading unquoted `~` → $HOME), then substitution.
      const b = this.tildeExpand(braw);
      const { parts, emptiedByAt } = await this.substitute(b);
      if (emptiedByAt && parts.length === 0) { anyEmptyByAt = true; continue; }
      // 3. word splitting (unquoted regions only)
      const fields = splitParts(parts);
      // 4. pathname expansion per field (unquoted only)
      for (const f of fields) {
        const globbed = await this.maybeGlob(f);
        if (globbed.nullglobbed) nullglobbed = true;
        out.push(...globbed.fields);
      }
    }
    // A word whose sole content was a `$@`/`${arr[@]}` that expanded to nothing,
    // OR a nullglob pattern that matched nothing, contributes zero fields (bash).
    // Other empty results keep the single-'' field.
    if (out.length > 0) return out;
    return (anyEmptyByAt || nullglobbed) ? [] : [''];
  }

  /** Expand only $-substitutions (no brace, splitting, or glob). For here-doc lines. */
  async substituteOnly(text: string): Promise<string> {
    const { parts } = await this.substitute(text);
    return partsText(parts);
  }

  /** Expand to a single joined string (no splitting/glob). For assignments, redirect targets. */
  async expandToString(word: string): Promise<string> {
    const braced = expandBraces(word);
    // Assignments/redirect targets don't brace-expand into multiple words in a
    // meaningful way here; join is acceptable for the common single-result case.
    const pieces: string[] = [];
    for (const braw of braced) {
      const { parts } = await this.substitute(this.tildeExpand(braw));
      pieces.push(partsText(parts));
    }
    return pieces.join(' ');
  }

  /**
   * Tilde expansion (H6): a leading unquoted `~` → `$HOME`, `~/rest` →
   * `$HOME/rest`. Only fires when the word literally starts with `~` (so quoted
   * `"~"` and mid-word `a~` are left alone). `~user` is left literal — there is
   * no user database in the sandbox. Disabled when `$HOME` is unset.
   */
  private tildeExpand(word: string): string {
    if (word[0] !== '~') return word;
    // `~` then end / `/` / `:` (PATH-like) — anything else (e.g. `~user`) is a
    // named-home form we don't support, so leave it literal.
    const rest = word.slice(1);
    if (rest === '' || rest[0] === '/') {
      const home = this.env.get('HOME');
      if (home === undefined || home === '') return word;
      return home + rest;
    }
    return word;
  }

  /**
   * Perform $-substitution over a brace-expanded word, producing tagged parts.
   * Tracks quoting so later word-splitting/glob only touch unquoted regions.
   */
  private async substitute(word: string): Promise<{ parts: Part[]; emptiedByAt: boolean }> {
    const parts: Part[] = [];
    // The "open" word being assembled. `started` distinguishes an empty-but-real
    // field (e.g. from `""`) from no field at all. `quoted` records whether the
    // current open word's content is protected from later word-splitting.
    let pending = '';
    let started = false;
    let quoted = false;
    // True iff every contribution so far was an `@`-form that expanded to nothing
    // (so the whole word collapses to zero fields, not one empty field).
    let emptiedByAt = false;
    let sawNonEmpty = false;
    const closeWord = (): void => {
      if (started) parts.push({ text: pending, quoted });
      pending = ''; started = false; quoted = false;
    };
    const addText = (s: string, q: boolean): void => {
      pending += s; started = true; sawNonEmpty = true; if (q) quoted = true;
    };

    /**
     * Emit a `$@`/`${arr[@]}` (`join === undefined`) or `$*`/`${arr[*]}` (joined)
     * expansion. The boundary rule for the `@`-form: the first element joins onto
     * whatever precedes it, each subsequent element opens a NEW field (fieldBreak
     * marker), and the last element is left open so trailing text joins onto it —
     * giving `"pre$@post"` → `prea`, `b`, `cpost`. `q` protects the produced
     * fields from word-splitting (the double-quoted case).
     */
    const emitFields = (fields: string[], join: string | undefined, q: boolean): void => {
      if (join !== undefined) { addText(fields.join(join), q); return; }
      if (fields.length === 0) { emptiedByAt = true; return; } // `@` with no elements
      sawNonEmpty = true;
      addText(fields[0], q);
      for (let k = 1; k < fields.length; k++) {
        closeWord();
        parts.push({ fieldBreak: true });
        addText(fields[k], q);
      }
    };

    let i = 0;
    const n = word.length;
    while (i < n) {
      const c = word[i];

      if (c === '\\') { addText(word[i + 1] ?? '', false); i += word[i + 1] !== undefined ? 2 : 1; continue; }

      if (c === '\'') {
        i++;
        let inner = '';
        while (i < n && word[i] !== '\'') { inner += word[i]; i++; }
        i++;
        addText(inner, true);
        continue;
      }

      if (c === '"') {
        i++;
        // A double-quoted run is one field, EXCEPT when its sole content is a
        // `"$@"`/`"${arr[@]}"` (which splits into per-element fields, or to NO
        // field when empty). `producedThisRun` tracks whether this run emitted
        // any real content; if not (and it wasn't an empty-@), it's a literal
        // `""` → one empty quoted field.
        let producedThisRun = false;
        let emptyAtThisRun = false;
        while (i < n && word[i] !== '"') {
          if (word[i] === '\\') {
            const next = word[i + 1] ?? '';
            if (next === '"' || next === '\\' || next === '$' || next === '`') { addText(next, true); producedThisRun = true; i += 2; continue; }
            addText('\\', true); producedThisRun = true; i++; continue;
          }
          if (word[i] === '$') {
            const r = await this.readDollar(word, i);
            if (r.fields !== undefined) {
              emitFields(r.fields, r.join, true);
              if (r.join === undefined && r.fields.length === 0) emptyAtThisRun = true; else producedThisRun = true;
            } else { addText(r.value, true); producedThisRun = true; }
            i = r.next; continue;
          }
          if (word[i] === '`') { const r = await this.readBacktick(word, i); addText(r.value, true); producedThisRun = true; i = r.next; continue; }
          addText(word[i], true); producedThisRun = true; i++;
        }
        i++;
        // Force a (possibly empty) quoted field unless the whole run was an empty
        // `"$@"` — `"" ` is still one empty field.
        if (!emptyAtThisRun || producedThisRun) { started = true; quoted = true; }
        continue;
      }

      if (c === '$') {
        const r = await this.readDollar(word, i);
        if (r.fields !== undefined) emitFields(r.fields, r.join, false);
        else addText(r.value, false);
        i = r.next; continue;
      }
      if (c === '`') { const r = await this.readBacktick(word, i); addText(r.value, false); i = r.next; continue; }

      // Process substitution `<(cmd)` / `>(cmd)` (M4) — substitute a VFS path.
      // Rejected in POSIX mode (a bash extension), matching the parser's other
      // posix-reject diagnostics; checked before the optional procSub wiring so
      // the rejection fires even when no FsClient is present.
      if ((c === '<' || c === '>') && word[i + 1] === '(') {
        if (this.env.posix?.()) {
          throw new ExpansionError('syntax error: process substitution is not supported in POSIX mode');
        }
        if (this.env.procSub) {
          const end = findMatchingParen(word, i + 2);
          const src = word.slice(i + 2, end);
          const path = await this.env.procSub(src, c === '<' ? 'in' : 'out');
          addText(path, false);
          i = end + 1; continue;
        }
      }

      addText(c, false); i++;
    }
    closeWord();
    // The word vanishes (zero fields) only when an `@`-form emptied it AND no
    // other content was produced. Otherwise an empty word is one empty field.
    if (parts.length === 0) {
      if (emptiedByAt && !sawNonEmpty) return { parts: [], emptiedByAt: true };
      return { parts: [{ text: '', quoted: false }], emptiedByAt: false };
    }
    return { parts, emptiedByAt: false };
  }

  /**
   * Positional params when the env doesn't implement {@link ShellEnv.getPositional}:
   * reconstruct from `$#` + `$1..$N` via {@link ShellEnv.getSpecial}.
   */
  private positionalFallback(): string[] {
    const count = parseInt(this.env.getSpecial('#') ?? '0', 10) || 0;
    const out: string[] = [];
    for (let k = 1; k <= count; k++) out.push(this.env.getSpecial(String(k)) ?? '');
    return out;
  }

  /** First character of IFS (the field separator used to join `$*`); default space. */
  private ifsFirst(): string {
    const ifs = this.env.get('IFS');
    if (ifs === undefined) return ' ';
    return ifs.length > 0 ? ifs[0] : ''; // empty IFS ⇒ no separator
  }

  /** Read a `$...` construct at word[i] === '$'. */
  private async readDollar(word: string, i: number): Promise<DollarResult> {
    const n = word.length;
    const c1 = word[i + 1];

    // $(( arithmetic )) — must check before $(
    if (c1 === '(' && word[i + 2] === '(') {
      const end = findMatchingArith(word, i + 3);
      const expr = word.slice(i + 3, end);
      const expanded = await this.expandSubExpr(expr);
      const liveEnv = this.arithEnvProxy();
      let v: number;
      try { v = evalArith(expanded, liveEnv); }
      catch (e) { throw new ExpansionError((e as Error).message); }
      return { value: String(v), next: end + 2 };
    }

    // $( command substitution )
    if (c1 === '(') {
      const end = findMatchingParen(word, i + 2);
      const src = word.slice(i + 2, end);
      const out = await this.env.runCommandSub(src);
      return { value: stripTrailingNewlines(out), next: end + 1 };
    }

    // ${ parameter expansion }
    if (c1 === '{') {
      const end = findMatchingBrace(word, i + 2);
      const body = word.slice(i + 2, end);
      const result = await this.paramExpansion(body);
      if (typeof result !== 'string') return { fields: result.fields, join: result.join, next: end + 1 };
      return { value: result, next: end + 1 };
    }

    // $@ / $* — positional params as multiple fields (@) or one joined field (*).
    if (c1 === '@' || c1 === '*') {
      const pos = this.env.getPositional?.() ?? this.positionalFallback();
      return { fields: pos, join: c1 === '*' ? this.ifsFirst() : undefined, next: i + 2 };
    }

    // Other special single-char params: ? # $ ! 0 - ($- = current option flags)
    if (c1 !== undefined && '?#$!0-'.includes(c1)) {
      return { value: this.env.getSpecial(c1) ?? '', next: i + 2 };
    }

    // Positional $1..$9 (single digit, bash multi-digit needs braces)
    if (c1 !== undefined && /[1-9]/.test(c1)) {
      return { value: this.env.getSpecial(c1) ?? '', next: i + 2 };
    }

    // $NAME
    let j = i + 1;
    let name = '';
    while (j < n && /[A-Za-z0-9_]/.test(word[j])) {
      if (name === '' && /[0-9]/.test(word[j])) break;
      name += word[j]; j++;
    }
    if (name === '') return { value: '$', next: i + 1 };
    // A bare `$arr` reference to an indexed array yields element 0 (bash).
    const arr = this.env.getArray?.(name);
    if (arr !== undefined) return { value: arr[0] ?? '', next: j };
    return { value: this.resolveVarStrict(name), next: j };
  }

  /** Read a `` `cmd` `` backtick substitution at word[i] === '`'. */
  private async readBacktick(word: string, i: number): Promise<{ value: string; next: number }> {
    const n = word.length;
    let j = i + 1;
    let src = '';
    while (j < n && word[j] !== '`') {
      if (word[j] === '\\' && (word[j + 1] === '`' || word[j + 1] === '\\' || word[j + 1] === '$')) {
        src += word[j + 1]; j += 2; continue;
      }
      src += word[j]; j++;
    }
    const out = await this.env.runCommandSub(src);
    return { value: stripTrailingNewlines(out), next: j + 1 };
  }

  /** Expand `$VAR` references inside an arithmetic/sub expression string first. */
  private async expandSubExpr(expr: string): Promise<string> {
    // Replace $name and ${name} with their values so the arith evaluator sees numbers.
    let out = '';
    let i = 0;
    while (i < expr.length) {
      if (expr[i] === '$') {
        const r = await this.readDollar(expr, i);
        out += r.fields !== undefined ? r.fields.join(r.join ?? ' ') : r.value;
        i = r.next; continue;
      }
      out += expr[i]; i++;
    }
    return out;
  }

  /** A live env proxy so arithmetic assignments persist to the shell env. */
  private arithEnvProxy(): Record<string, string> {
    const env = this.env;
    return new Proxy({}, {
      get: (_t, p: string) => env.get(p) ?? '',
      set: (_t, p: string, v) => { env.set(p, String(v)); return true; },
      has: (_t, p: string) => env.has(p),
    }) as Record<string, string>;
  }

  /** Resolve a plain variable, falling back to special-param lookup. */
  private resolveVar(name: string): string {
    const v = this.env.get(name);
    if (v !== undefined) return v;
    return this.env.getSpecial(name) ?? '';
  }

  /**
   * Resolve a BARE `$name` / `${name}` reference, honoring `set -u` (nounset):
   * an unset variable throws (the shell aborts). Default/alternate forms
   * (`${name:-…}`, `${name+…}`, …) use {@link resolveVar} instead, since they
   * legitimately handle the unset case themselves.
   */
  private resolveVarStrict(name: string): string {
    const v = this.env.get(name);
    if (v !== undefined) return v;
    const special = this.env.getSpecial(name);
    if (special !== undefined) return special;
    if (this.env.nounset?.()) {
      throw new ExpansionError(`${name}: unbound variable`);
    }
    return '';
  }

  /** Expand an array subscript expression (may contain `$i`) to an integer. */
  private async resolveIndex(subscript: string): Promise<number> {
    const expanded = await this.substituteOnly(subscript);
    return parseInt(expanded.trim(), 10) || 0;
  }

  /**
   * Parse and apply a `${...}` parameter-expansion body. Returns a plain string,
   * or a multi-field descriptor for the `@`/`*` array/positional forms (consumed
   * by {@link readDollar} → {@link substitute} for field splitting).
   */
  private async paramExpansion(body: string): Promise<string | { fields: string[]; join: string | undefined }> {
    // ${#@} / ${#*} → positional COUNT; ${#name[@]}/${#name[*]} → element count.
    if (body.startsWith('#') && body.length > 1) {
      const inner = body.slice(1);
      if (inner === '@' || inner === '*') {
        const pos = this.env.getPositional?.() ?? this.positionalFallback();
        return String(pos.length);
      }
      const sub = matchSubscript(inner);
      if (sub) {
        const map = this.env.getAssoc?.(sub.name);
        if (map !== undefined) {
          if (sub.subscript === '@' || sub.subscript === '*') return String(map.size);
          const key = await this.substituteOnly(sub.subscript);
          return String((map.get(key) ?? '').length);
        }
        const arr = this.env.getArray?.(sub.name) ?? [];
        if (sub.subscript === '@' || sub.subscript === '*') return String(arr.length);
        const idx = await this.resolveIndex(sub.subscript);
        return String((arr[idx] ?? '').length);
      }
      return String(this.resolveVar(inner).length);
    }

    // ${!name[@]} / ${!name[*]} → array indices; ${!prefix*}/${!prefix@} → names
    // with that prefix; ${!var} → indirect expansion.
    if (body.startsWith('!') && body.length > 1) {
      const inner = body.slice(1);
      const sub = matchSubscript(inner);
      if (sub && (sub.subscript === '@' || sub.subscript === '*')) {
        // ${!assoc[@]} → keys; ${!indexed[@]} → numeric indices (G6).
        const map = this.env.getAssoc?.(sub.name);
        if (map !== undefined) {
          return { fields: [...map.keys()], join: sub.subscript === '*' ? this.ifsFirst() : undefined };
        }
        const arr = this.env.getArray?.(sub.name) ?? [];
        return arr.map((_, i) => i).join(' ');
      }
      // ${!prefix*} / ${!prefix@}: every set variable name starting with prefix.
      if ((inner.endsWith('*') || inner.endsWith('@')) && /^[A-Za-z_][A-Za-z0-9_]*[*@]$/.test(inner)) {
        const prefix = inner.slice(0, -1);
        const matches = (this.env.names?.() ?? []).filter((n) => n.startsWith(prefix)).sort();
        return { fields: matches, join: inner.endsWith('*') ? this.ifsFirst() : undefined };
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
        // Indirection: the value of the variable NAMED by `inner`.
        const target = this.resolveVar(inner);
        return target === '' ? '' : this.resolveVar(target);
      }
    }

    // ${@} / ${*} bare positional forms (equivalent to $@ / $*).
    if (body === '@' || body === '*') {
      const pos = this.env.getPositional?.() ?? this.positionalFallback();
      return { fields: pos, join: body === '*' ? this.ifsFirst() : undefined };
    }

    // ${name[subscript]} array element / slice access.
    const subAccess = matchSubscript(body);
    // Associative array (`declare -A`): string-keyed access (G6).
    if (subAccess && this.env.getAssoc?.(subAccess.name) !== undefined) {
      const map = this.env.getAssoc(subAccess.name)!;
      if (subAccess.subscript === '@' || subAccess.subscript === '*') {
        return { fields: [...map.values()], join: subAccess.subscript === '*' ? this.ifsFirst() : undefined };
      }
      const key = await this.substituteOnly(subAccess.subscript);
      return map.get(key) ?? '';
    }
    if (subAccess && this.env.getArray?.(subAccess.name) !== undefined) {
      const arr = this.env.getArray(subAccess.name)!;
      if (subAccess.subscript === '@' || subAccess.subscript === '*') {
        return { fields: arr, join: subAccess.subscript === '*' ? this.ifsFirst() : undefined };
      }
      const idx = await this.resolveIndex(subAccess.subscript);
      return arr[idx] ?? '';
    }

    // Find the operator. Operators: :- := :? :+ - = ? + # ## % %% / // : (substring)
    const m = body.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?#$!])(.*)$/s);
    if (!m) return this.resolveVar(body);
    const name = m[1];
    const rest = m[2];
    if (rest === '') {
      // A bare ${arr} (no subscript) on an array → element 0 (bash semantics).
      const arr = this.env.getArray?.(name);
      if (arr !== undefined) return arr[0] ?? '';
      return this.resolveVarStrict(name);
    }

    const set = this.env.has(name) || this.env.getSpecial(name) !== undefined;
    const value = this.resolveVar(name);

    // ${var@OP} parameter transforms. @Q = quote for re-input (the one we support).
    // `${arr[@]}` is handled earlier (matchSubscript), so rest[0] === '@' here only
    // means the ${var@OP} transform form.
    if (rest[0] === '@') {
      const op = rest[1];
      if (op === 'Q') return shellQuote(value);
      if (op === 'U') return value.toUpperCase();
      if (op === 'u') return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
      if (op === 'L') return value.toLowerCase();
      if (op === 'E') return interpretEscapes(value, /*octalBackslashZero*/ false);
      // `@a` reports the variable's attribute FLAGS (keyed by NAME, not value).
      if (op === 'a') return this.env.attrFlags?.(name) ?? '';
      // Other transforms (@P @A @K @k) are not yet supported — return the value
      // unchanged rather than erroring (forward-compatible; documented).
      return value;
    }

    // ${var:-word} ${var:=word} ${var:?word} ${var:+word}
    if (rest[0] === ':' && '-=?+'.includes(rest[1] ?? '')) {
      const op = rest[1];
      const arg = await this.expandToString(rest.slice(2));
      const unsetOrEmpty = !set || value === '';
      switch (op) {
        case '-': return unsetOrEmpty ? arg : value;
        case '+': return unsetOrEmpty ? '' : arg;
        case '=': if (unsetOrEmpty) { this.env.set(name, arg); return arg; } return value;
        case '?': if (unsetOrEmpty) throw new ExpansionError(arg || `${name}: parameter null or not set`); return value;
      }
    }
    // ${var-word} ${var=word} ${var?word} ${var+word} (only-unset variants)
    if ('-=?+'.includes(rest[0])) {
      const op = rest[0];
      const arg = await this.expandToString(rest.slice(1));
      switch (op) {
        case '-': return set ? value : arg;
        case '+': return set ? arg : '';
        case '=': if (!set) { this.env.set(name, arg); return arg; } return value;
        case '?': if (!set) throw new ExpansionError(arg || `${name}: parameter not set`); return value;
      }
    }

    // ${var#pat} ${var##pat} prefix strip
    if (rest[0] === '#') {
      const longest = rest[1] === '#';
      const pat = await this.expandToString(rest.slice(longest ? 2 : 1));
      return stripPrefix(value, pat, longest, this.globOpts());
    }
    // ${var%pat} ${var%%pat} suffix strip
    if (rest[0] === '%') {
      const longest = rest[1] === '%';
      const pat = await this.expandToString(rest.slice(longest ? 2 : 1));
      return stripSuffix(value, pat, longest, this.globOpts());
    }
    // ${var/pat/repl} ${var//pat/repl}
    if (rest[0] === '/') {
      const all = rest[1] === '/';
      const spec = rest.slice(all ? 2 : 1);
      const slash = findUnescaped(spec, '/');
      const pat = await this.expandToString(slash >= 0 ? spec.slice(0, slash) : spec);
      const repl = slash >= 0 ? await this.expandToString(spec.slice(slash + 1)) : '';
      return substitute(value, pat, repl, all, this.globOpts());
    }
    // ${var^} ${var^^} ${var,} ${var,,} — case modification (optionally gated by
    // a glob pattern of which chars to convert; default matches every char).
    if (rest[0] === '^' || rest[0] === ',') {
      const upper = rest[0] === '^';
      const all = rest[1] === rest[0];
      const patStr = rest.slice(all ? 2 : 1);
      const pat = patStr === '' ? '?' : await this.expandToString(patStr);
      const re = new RegExp('^' + globToReSource(pat, this.globOpts()) + '$');
      const conv = (ch: string): string => (re.test(ch) ? (upper ? ch.toUpperCase() : ch.toLowerCase()) : ch);
      if (all) return value.split('').map(conv).join('');
      return value.length === 0 ? value : conv(value[0]) + value.slice(1);
    }

    // ${var:offset:len} substring (offset is numeric → not one of the : ops above)
    if (rest[0] === ':') {
      const spec = rest.slice(1);
      const colon = spec.indexOf(':');
      const offStr = colon >= 0 ? spec.slice(0, colon) : spec;
      const lenStr = colon >= 0 ? spec.slice(colon + 1) : undefined;
      let off = parseInt(offStr.trim(), 10) || 0;
      if (off < 0) off = Math.max(0, value.length + off);
      if (lenStr === undefined) return value.slice(off);
      const len = parseInt(lenStr.trim(), 10) || 0;
      if (len < 0) return value.slice(off, value.length + len);
      return value.slice(off, off + len);
    }

    return value;
  }

  /**
   * Glob options for STRING-matching contexts (parameter `${var#pat}`, case-mod):
   * `*`/`?` cross `/` (pathSegment:false). extglob honored; nocaseglob applies.
   */
  private globOpts(): GlobOptions {
    return { extglob: this.env.shopt?.('extglob') ?? false, nocase: this.env.shopt?.('nocaseglob') ?? false, pathSegment: false };
  }

  /** Glob options for PATHNAME expansion: `*`/`?` do NOT cross `/` (pathSegment:true). */
  private pathGlobOpts(): GlobOptions {
    return { extglob: this.env.shopt?.('extglob') ?? false, nocase: this.env.shopt?.('nocaseglob') ?? false, pathSegment: true };
  }

  /**
   * Glob a field against the VFS. An unmatched pattern stays literal UNLESS
   * `nullglob` is on (then it produces zero fields). `null` ⇒ the field had no
   * glob metacharacter.
   */
  private async maybeGlob(field: string): Promise<{ fields: string[]; nullglobbed?: boolean }> {
    const extglob = this.env.shopt?.('extglob') ?? false;
    const globstar = this.env.shopt?.('globstar') ?? false;
    if (!isGlobPattern(field, extglob)) return { fields: [field] };
    const matches = await this.globPath(field, globstar);
    if (matches.length > 0) return { fields: matches };
    // nullglob: a non-matching pattern expands to nothing (zero fields).
    if (this.env.shopt?.('nullglob')) return { fields: [], nullglobbed: true };
    return { fields: [field] };
  }

  private async globPath(pattern: string, globstar: boolean): Promise<string[]> {
    const absolute = pattern.startsWith('/');
    const baseDir = absolute ? '/' : (this.env.cwd ?? '.');
    const segments = pattern.split('/').filter((s, idx) => !(idx === 0 && s === ''));
    const results = await this.globSegments(baseDir, segments, globstar);
    results.sort();
    return results.map((r) => {
      if (absolute) return r;
      const prefix = baseDir === '.' ? '' : baseDir.replace(/\/$/, '') + '/';
      return r.startsWith(prefix) ? r.slice(prefix.length) : r;
    });
  }

  private async globSegments(dir: string, segments: string[], globstar: boolean): Promise<string[]> {
    if (segments.length === 0) return [dir];
    const [seg, ...rest] = segments;
    if (seg === '') return this.globSegments(dir, rest, globstar);
    const opts = this.pathGlobOpts();
    const dotglob = this.env.shopt?.('dotglob') ?? false;

    // globstar `**`: match this directory and all descendants (recursively).
    if (globstar && seg === '**') {
      const here = await this.globSegments(dir, rest, globstar);
      const out = [...here];
      const entries = await this.env.listDir(dir);
      for (const e of entries ?? []) {
        if (e.startsWith('.') && !dotglob) continue;
        const full = joinPath(dir, e);
        if (await this.isDir(full)) out.push(...await this.globSegments(full, segments, globstar));
      }
      return out;
    }

    if (!isGlobPattern(seg, opts.extglob)) {
      const next = joinPath(dir, seg);
      return this.globSegments(next, rest, globstar);
    }

    const entries = await this.env.listDir(dir);
    if (!entries) return [];
    const re = globToRegExp(seg, opts);
    // dotfiles are hidden unless the pattern starts with `.` OR dotglob is on.
    const matched = entries.filter((e) => re.test(e) && !(e.startsWith('.') && !seg.startsWith('.') && !dotglob));
    const out: string[] = [];
    for (const m of matched) {
      const full = joinPath(dir, m);
      if (rest.length === 0) out.push(full);
      else out.push(...await this.globSegments(full, rest, globstar));
    }
    return out;
  }

  private async isDir(path: string): Promise<boolean> {
    const s = await this.env.statPath?.(path);
    return s?.dir ?? false;
  }
}

/** Parse a `name[subscript]` form (the whole string), e.g. `arr[0]`, `arr[@]`. */
function matchSubscript(s: string): { name: string; subscript: string } | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s.exec(s);
  if (!m) return undefined;
  return { name: m[1], subscript: m[2] };
}

function joinPath(dir: string, name: string): string {
  if (dir === '.' || dir === '') return name;
  return dir.replace(/\/$/, '') + '/' + name;
}

// ── brace expansion ──────────────────────────────────────────────────────────

/** Expand brace patterns. Returns ≥1 strings. Quotes/escapes suppress braces. */
export function expandBraces(word: string): string[] {
  const expansion = findBrace(word);
  if (!expansion) return [word];
  const { pre, body, post, isRange } = expansion;
  let items: string[];
  if (isRange) {
    items = expandRange(body);
    if (items === null as unknown as string[]) {
      // not a valid range → treat literally
      return expandBraces(pre + '{' + body + '}' + post).map((s) => s);
    }
  } else {
    items = splitTopLevel(body);
  }
  const tails = expandBraces(post);
  const out: string[] = [];
  for (const item of items) {
    // each item may itself contain nested braces
    for (const ex of expandBraces(item)) {
      for (const tail of tails) out.push(pre + ex + tail);
    }
  }
  return out;
}

interface BraceMatch { pre: string; body: string; post: string; isRange: boolean; }

/**
 * Skip over a `$`-construct (`${...}`, `$(...)`, `$((...))`) that starts at
 * `word[i] === '$'`, returning the index just past it. A non-construct `$`
 * returns i+1. Used so brace-expansion scanning never treats a comma inside a
 * `${var,,}` / `$(cmd a,b)` as a brace separator (the H7 corruption bug).
 */
function skipDollar(word: string, i: number): number {
  if (word[i] !== '$') return i + 1;
  const c1 = word[i + 1];
  if (c1 === '{') return findMatchingBrace(word, i + 2) + 1;
  if (c1 === '(') {
    if (word[i + 2] === '(') return findMatchingArith(word, i + 3) + 2;
    return findMatchingParen(word, i + 2) + 1;
  }
  return i + 1;
}

/** Find the first top-level `{...}` (respecting quotes/escapes, nesting, and `$`-constructs). */
function findBrace(word: string): BraceMatch | undefined {
  let i = 0;
  const n = word.length;
  while (i < n) {
    const c = word[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '$' && (word[i + 1] === '{' || word[i + 1] === '(')) { i = skipDollar(word, i); continue; }
    if (c === '\'' || c === '"') {
      const q = c; i++;
      while (i < n && word[i] !== q) { if (word[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '{') {
      // find matching close at the same depth, requiring a comma or `..` to qualify
      let depth = 1;
      let j = i + 1;
      let hasComma = false;
      let hasRange = false;
      const start = j;
      while (j < n && depth > 0) {
        const cc = word[j];
        if (cc === '\\') { j += 2; continue; }
        if (cc === '$' && (word[j + 1] === '{' || word[j + 1] === '(')) { j = skipDollar(word, j); continue; }
        if (cc === '\'' || cc === '"') { const q = cc; j++; while (j < n && word[j] !== q) { if (word[j] === '\\') j++; j++; } j++; continue; }
        if (cc === '{') depth++;
        else if (cc === '}') { depth--; if (depth === 0) break; }
        else if (cc === ',' && depth === 1) hasComma = true;
        else if (cc === '.' && word[j + 1] === '.' && depth === 1) hasRange = true;
        j++;
      }
      if (depth === 0) {
        const body = word.slice(start, j);
        if (hasComma) return { pre: word.slice(0, i), body, post: word.slice(j + 1), isRange: false };
        if (hasRange && /^[^,]*\.\.[^,]*$/.test(body)) return { pre: word.slice(0, i), body, post: word.slice(j + 1), isRange: true };
        // brace without comma/range → not an expansion; skip past it
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return undefined;
}

/** Split `a,b{,x},c` on top-level commas (respecting nested braces/quotes/`$`-constructs). */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') { cur += c + (body[i + 1] ?? ''); i += 2; continue; }
    if (c === '$' && (body[i + 1] === '{' || body[i + 1] === '(')) {
      const end = skipDollar(body, i); cur += body.slice(i, end); i = end; continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  out.push(cur);
  return out;
}

/** Expand `1..5`, `a..e`, `1..10..2`. Returns null-ish on invalid. */
function expandRange(body: string): string[] {
  const parts = body.split('..');
  if (parts.length < 2 || parts.length > 3) return null as unknown as string[];
  const [a, b, stepStr] = parts;
  const step = stepStr !== undefined ? Math.abs(parseInt(stepStr, 10)) || 1 : 1;
  // numeric
  if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) {
    const start = parseInt(a, 10), end = parseInt(b, 10);
    const out: string[] = [];
    if (start <= end) for (let v = start; v <= end; v += step) out.push(String(v));
    else for (let v = start; v >= end; v -= step) out.push(String(v));
    return out;
  }
  // alpha
  if (/^[A-Za-z]$/.test(a) && /^[A-Za-z]$/.test(b)) {
    const start = a.charCodeAt(0), end = b.charCodeAt(0);
    const out: string[] = [];
    if (start <= end) for (let v = start; v <= end; v += step) out.push(String.fromCharCode(v));
    else for (let v = start; v >= end; v -= step) out.push(String.fromCharCode(v));
    return out;
  }
  return null as unknown as string[];
}

// ── matching helpers ─────────────────────────────────────────────────────────

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

function findMatchingArith(s: string, start: number): number {
  // returns index of the first `)` of the closing `))`
  let depth = 0;
  let i = start;
  while (i < s.length) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      if (depth === 0 && s[i + 1] === ')') return i;
      depth--;
    }
    i++;
  }
  return s.length;
}

function findMatchingBrace(s: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return s.length;
}

function findUnescaped(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === ch) return i;
  }
  return -1;
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '');
}

// ── pattern matching (glob-style for ${} strip/subst and pathname) ───────────

function stripPrefix(value: string, pat: string, longest: boolean, opts: GlobOptions): string {
  // try match anchored at start; longest vs shortest
  const lengths = [];
  for (let k = 0; k <= value.length; k++) lengths.push(k);
  const candidates = longest ? lengths.reverse() : lengths;
  const re = new RegExp('^' + globToReSource(pat, opts) + '$');
  for (const len of candidates) {
    if (re.test(value.slice(0, len))) return value.slice(len);
  }
  return value;
}

function stripSuffix(value: string, pat: string, longest: boolean, opts: GlobOptions): string {
  const lengths = [];
  for (let k = 0; k <= value.length; k++) lengths.push(k);
  const candidates = longest ? lengths.reverse() : lengths;
  const re = new RegExp('^' + globToReSource(pat, opts) + '$');
  for (const len of candidates) {
    const start = value.length - len;
    if (re.test(value.slice(start))) return value.slice(0, start);
  }
  return value;
}

function substitute(value: string, pat: string, repl: string, all: boolean, opts: GlobOptions): string {
  if (pat === '') return value;
  // Anchors: leading '#' = match at start, trailing '%' = match at end.
  let anchorStart = false, anchorEnd = false;
  let p = pat;
  if (p[0] === '#') { anchorStart = true; p = p.slice(1); }
  if (p[p.length - 1] === '%') { anchorEnd = true; p = p.slice(0, -1); }
  const reSrc = globToReSource(p, opts);
  if (anchorStart) return value.replace(new RegExp('^' + reSrc), repl);
  if (anchorEnd) return value.replace(new RegExp(reSrc + '$'), repl);
  const flags = all ? 'g' : '';
  // Non-greedy to mimic shell leftmost-shortest for `/` substitution.
  return value.replace(new RegExp(reSrc.replace(/\.\*/g, '.*?'), flags), repl);
}

// ── word splitting ───────────────────────────────────────────────────────────

/** Join a part stream into a single string (for non-splitting contexts). */
function partsText(parts: Part[]): string {
  let s = '';
  for (const p of parts) if (!p.fieldBreak) s += p.text;
  return s;
}

function splitParts(parts: Part[]): string[] {
  const fields: string[] = [];
  let current = '';
  let started = false;
  for (const part of parts) {
    if (part.fieldBreak) {
      // Hard boundary between `$@`/`${arr[@]}` elements: close the field even
      // when adjacent quoted text would otherwise join across it.
      fields.push(current); current = ''; started = false;
      continue;
    }
    if (part.quoted) { current += part.text; started = true; continue; }
    const t = part.text;
    let k = 0;
    while (k < t.length) {
      if (/\s/.test(t[k])) {
        if (started) { fields.push(current); current = ''; started = false; }
        while (k < t.length && /\s/.test(t[k])) k++;
      } else { current += t[k]; started = true; k++; }
    }
  }
  if (started) fields.push(current);
  return fields.length > 0 ? fields : [''];
}

/**
 * `sed` — stream editor (subset with full GNU parity on the common path).
 *
 * Flags: `-e SCRIPT` (repeatable), `-n` quiet, `-E`/`-r` ERE, `-i` in-place
 * (write the result back to the VFS file). Multiple files.
 *
 * Addresses: line `N`, last line `$`, regex `/re/`, ranges `N,M` and
 * `/re1/,/re2/`. A range starts when its first address matches and stays active
 * through the line where the second matches (GNU semantics). GNU extensions:
 * step `first~step` (e.g. `1~2` = odd lines, `0~3` = 3,6,9…), `addr,+N`
 * (N lines after the start match) and `addr,~N` (until the next line whose
 * number is a multiple of N).
 *
 * Commands: `s/pat/repl/flags` (flags `g` global, `i`/`I` ignore-case, `p`
 * print, and a numeric Nth-occurrence), with `&` (whole match) and `\1..\9`
 * (capture groups) in the replacement; `p` print, `d` delete, `q` quit,
 * `=` print line number, `a TEXT` append, `i TEXT` insert, `c TEXT` change,
 * `y/abc/xyz/` transliterate; brace groups `{ … }` (address-gated, nestable);
 * hold space `h H g G x`; multi-line `N D P`; branching `b t T` with `:label`.
 *
 * The executor is a proper cycle engine: for each input line (a "cycle") it runs
 * a program-counter loop over the parsed command list, so `b`/`t`/`T` can jump,
 * `D` can restart the cycle, and brace blocks can be skipped when their address
 * does not match.
 *
 * Regex syntax defaults to BRE; `-E`/`-r` selects ERE (see `_regex.ts` for the
 * honest BRE↔ERE translation). `.` does not match newline (sed pattern space is
 * normally one line, though `N` can make it multi-line).
 */
import { defineCommand, readAllText, writeBytes, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { compilePattern } from './_regex.ts';
import type { RegexSyntax } from './_regex.ts';

// ── address & command model ──────────────────────────────────────────────────

type Address =
  | { kind: 'line'; n: number }
  | { kind: 'last' }
  // `re` is undefined for the empty `//` form, which reuses the last regex.
  | { kind: 'regex'; re?: RegExp }
  | { kind: 'step'; first: number; step: number };

/** Trailing form of a range's second address: a plain address, `+N`, or `~N`. */
type EndAddress =
  | Address
  | { kind: 'plus'; n: number }
  | { kind: 'multiple'; n: number };

interface AddressSpec {
  /** undefined = every line; one = single address; two = range. */
  start?: Address;
  end?: EndAddress;
  /** `!` negation — the command runs when the address does NOT match. */
  negate?: boolean;
}

interface Subst {
  type: 's';
  // `re` is undefined for an empty `s//repl/` pattern, which reuses the last
  // regex resolved during execution; otherwise it is compiled with 'g'.
  re?: RegExp;
  ignoreCase: boolean; // needed to rebuild the empty-pattern regex from lastRegex
  replacement: string;
  global: boolean;
  nth: number; // replace the Nth occurrence (1-based); 0 = first only unless global
  print: boolean; // s///p
}

type Command =
  | (AddressSpec & Subst)
  | (AddressSpec & { type: 'p' })
  | (AddressSpec & { type: 'P' })
  | (AddressSpec & { type: 'd' })
  | (AddressSpec & { type: 'D' })
  | (AddressSpec & { type: 'q'; code: number })
  | (AddressSpec & { type: 'Q'; code: number })
  | (AddressSpec & { type: '=' })
  | (AddressSpec & { type: 'a'; text: string })
  | (AddressSpec & { type: 'i'; text: string })
  | (AddressSpec & { type: 'c'; text: string })
  | (AddressSpec & { type: 'y'; from: string; to: string })
  | (AddressSpec & { type: 'h' })
  | (AddressSpec & { type: 'H' })
  | (AddressSpec & { type: 'g' })
  | (AddressSpec & { type: 'G' })
  | (AddressSpec & { type: 'x' })
  | (AddressSpec & { type: 'n' })
  | (AddressSpec & { type: 'N' })
  | (AddressSpec & { type: 'b'; label: string })
  | (AddressSpec & { type: 't'; label: string })
  | (AddressSpec & { type: 'T'; label: string })
  | (AddressSpec & { type: ':'; label: string })
  // Brace group markers. `{` carries the address that gates the block and the
  // index of its matching `}`; `}` is an inert terminator the PC steps over.
  | (AddressSpec & { type: '{'; close: number })
  | { type: '}' };

interface SedConfig {
  suppress: boolean;
  inPlace: boolean;
  syntax: RegexSyntax;
  expressions: string[];
  files: string[];
}

// ── argument parsing ──────────────────────────────────────────────────────────

function parseSedArgs(argv: string[]): SedConfig {
  const c: SedConfig = { suppress: false, inPlace: false, syntax: 'bre', expressions: [], files: [] };
  let scriptTaken = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') { i++; while (i < argv.length) { c.files.push(argv[i]); i++; } break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const val = eq >= 0 ? arg.slice(eq + 1) : undefined;
      switch (name) {
        case 'in-place': c.inPlace = true; break;
        case 'quiet': case 'silent': c.suppress = true; break;
        case 'regexp-extended': c.syntax = 'ere'; break;
        case 'expression':
          c.expressions.push(val !== undefined ? val : (argv[++i] ?? ''));
          scriptTaken = true;
          break;
        default: break;
      }
      i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const cluster = arg.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const ch = cluster[j];
        if (ch === 'i') c.inPlace = true;
        else if (ch === 'n') c.suppress = true;
        else if (ch === 'r' || ch === 'E') c.syntax = 'ere';
        else if (ch === 'e') {
          const rest = cluster.slice(j + 1);
          c.expressions.push(rest.length > 0 ? rest : (argv[++i] ?? ''));
          scriptTaken = true;
          j = cluster.length;
        }
      }
      i++;
      continue;
    }
    // First bare operand is the script (unless -e already supplied one).
    if (!scriptTaken && c.expressions.length === 0) {
      c.expressions.push(arg);
      scriptTaken = true;
    } else {
      c.files.push(arg);
    }
    i++;
  }
  return c;
}

// ── script parsing ─────────────────────────────────────────────────────────────

class ScriptParser {
  #syntax: RegexSyntax;
  constructor(syntax: RegexSyntax) { this.#syntax = syntax; }

  #compile(pat: string, flags = ''): RegExp {
    return compilePattern(pat, { syntax: this.#syntax, flags });
  }

  /**
   * Parse the joined script text into a flat command list. Brace groups become a
   * `{` marker (with its address and the index of the matching `}`) followed by
   * the inner commands and a `}` marker, so the executor's PC loop can skip a
   * whole block by jumping to `close + 1`.
   */
  parse(script: string): Command[] {
    const cmds: Command[] = [];
    const openStack: number[] = [];
    let i = 0;
    const n = script.length;
    while (i < n) {
      // Skip separators / whitespace between commands.
      while (i < n && (script[i] === ';' || script[i] === '\n' || script[i] === ' ' || script[i] === '\t')) i++;
      if (i >= n) break;
      if (script[i] === '}') {
        const open = openStack.pop();
        if (open === undefined) throw new Error('unexpected `}\'');
        const close = cmds.length;
        cmds.push({ type: '}' });
        (cmds[open] as { close: number }).close = close;
        i++;
        continue;
      }
      const r = this.#parseOne(script, i);
      if (r.cmd.type === '{') openStack.push(cmds.length);
      cmds.push(r.cmd);
      i = r.next;
    }
    if (openStack.length > 0) throw new Error('unmatched `{\'');
    return cmds;
  }

  #parseSingleAddress(script: string, i: number): { addr?: Address; next: number } {
    const c = script[i];
    if (c === '$') return { addr: { kind: 'last' }, next: i + 1 };
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < script.length && script[j] >= '0' && script[j] <= '9') j++;
      const first = Number(script.slice(i, j));
      // GNU step address `first~step`.
      if (script[j] === '~') {
        let k = j + 1;
        while (k < script.length && script[k] >= '0' && script[k] <= '9') k++;
        const step = Number(script.slice(j + 1, k));
        return { addr: { kind: 'step', first, step }, next: k };
      }
      return { addr: { kind: 'line', n: first }, next: j };
    }
    if (c === '/' || c === '\\') {
      // `/re/` or `\cREc` (custom delimiter introduced by a backslash).
      let delim = '/';
      let j = i + 1;
      if (c === '\\') { delim = script[i + 1]; j = i + 2; }
      let pat = '';
      while (j < script.length && script[j] !== delim) {
        if (script[j] === '\\' && j + 1 < script.length) {
          if (script[j + 1] === delim) { pat += delim; j += 2; continue; }
          pat += script[j] + script[j + 1];
          j += 2;
          continue;
        }
        pat += script[j];
        j++;
      }
      if (script[j] !== delim) throw new Error('unterminated address regex');
      // An empty pattern (`//`) reuses the last regex at execution time.
      return { addr: { kind: 'regex', re: pat === '' ? undefined : this.#compile(pat) }, next: j + 1 };
    }
    return { next: i };
  }

  #parseAddressSpec(script: string, start: number): { spec: AddressSpec; next: number } {
    let i = start;
    const spec: AddressSpec = {};
    const a1 = this.#parseSingleAddress(script, i);
    if (a1.addr) {
      spec.start = a1.addr;
      i = a1.next;
      if (script[i] === ',') {
        i++;
        // `addr,+N` and `addr,~N` (GNU relative ends).
        if (script[i] === '+' || script[i] === '~') {
          const kind = script[i] === '+' ? 'plus' : 'multiple';
          let j = i + 1;
          while (j < script.length && script[j] >= '0' && script[j] <= '9') j++;
          spec.end = { kind, n: Number(script.slice(i + 1, j)) };
          i = j;
        } else {
          const a2 = this.#parseSingleAddress(script, i);
          if (!a2.addr) throw new Error('expected second address');
          spec.end = a2.addr;
          i = a2.next;
        }
      }
    }
    // Optional `!` negation, possibly preceded by spaces.
    while (script[i] === ' ' || script[i] === '\t') i++;
    if (script[i] === '!') { spec.negate = true; i++; while (script[i] === ' ' || script[i] === '\t') i++; }
    return { spec, next: i };
  }

  #parseOne(script: string, start: number): { cmd: Command; next: number } {
    const a = this.#parseAddressSpec(script, start);
    const spec = a.spec;
    let i = a.next;
    const cmdChar = script[i];
    if (cmdChar === undefined) throw new Error('missing command');
    i++;
    switch (cmdChar) {
      case '{': return { cmd: { ...spec, type: '{', close: -1 }, next: i };
      case 's': return this.#parseSubst(script, i, spec);
      case 'y': return this.#parseTransliterate(script, i, spec);
      case 'p': return { cmd: { ...spec, type: 'p' }, next: i };
      case 'P': return { cmd: { ...spec, type: 'P' }, next: i };
      case 'd': return { cmd: { ...spec, type: 'd' }, next: i };
      case 'D': return { cmd: { ...spec, type: 'D' }, next: i };
      case 'q': case 'Q': {
        // Optional exit-code argument: `q5` / `Q5`.
        let j = i;
        while (j < script.length && script[j] >= '0' && script[j] <= '9') j++;
        const code = j > i ? Number(script.slice(i, j)) : 0;
        return { cmd: { ...spec, type: cmdChar, code }, next: j };
      }
      case '=': return { cmd: { ...spec, type: '=' }, next: i };
      case 'h': return { cmd: { ...spec, type: 'h' }, next: i };
      case 'H': return { cmd: { ...spec, type: 'H' }, next: i };
      case 'g': return { cmd: { ...spec, type: 'g' }, next: i };
      case 'G': return { cmd: { ...spec, type: 'G' }, next: i };
      case 'x': return { cmd: { ...spec, type: 'x' }, next: i };
      case 'n': return { cmd: { ...spec, type: 'n' }, next: i };
      case 'N': return { cmd: { ...spec, type: 'N' }, next: i };
      case 'b': case 't': case 'T': {
        const l = this.#parseLabel(script, i);
        return { cmd: { ...spec, type: cmdChar, label: l.label }, next: l.next };
      }
      case ':': {
        const l = this.#parseLabel(script, i);
        if (l.label === '') throw new Error('":" lacks a label');
        return { cmd: { ...spec, type: ':', label: l.label }, next: l.next };
      }
      case 'a': case 'i': case 'c': {
        const t = this.#parseText(script, i);
        return { cmd: { ...spec, type: cmdChar, text: t.text }, next: t.next };
      }
      default:
        throw new Error(`unknown command: \`${cmdChar}'`);
    }
  }

  /** Parse a branch/label name: runs to `;`, `}`, newline, or end. */
  #parseLabel(script: string, i: number): { label: string; next: number } {
    while (script[i] === ' ' || script[i] === '\t') i++;
    let label = '';
    while (i < script.length && script[i] !== ';' && script[i] !== '\n' && script[i] !== '}') {
      label += script[i];
      i++;
    }
    return { label: label.trim(), next: i };
  }

  /** Parse the text argument of a/i/c. Supports `a\<newline>text` and `a text`. */
  #parseText(script: string, i: number): { text: string; next: number } {
    // Skip a leading backslash (GNU `a\` form) and any spaces.
    if (script[i] === '\\') {
      i++;
      if (script[i] === '\n') i++;
    } else {
      while (script[i] === ' ' || script[i] === '\t') i++;
    }
    let text = '';
    while (i < script.length && script[i] !== '\n') {
      if (script[i] === '\\' && i + 1 < script.length) {
        const nx = script[i + 1];
        if (nx === 'n') text += '\n';
        else if (nx === 't') text += '\t';
        else text += nx;
        i += 2;
        continue;
      }
      text += script[i];
      i++;
    }
    return { text, next: i };
  }

  #parseSubst(script: string, i: number, spec: AddressSpec): { cmd: Command; next: number } {
    const delim = script[i];
    if (delim === undefined) throw new Error('unterminated `s\' command');
    i++;
    const readField = (): string => {
      let f = '';
      while (i < script.length && script[i] !== delim) {
        if (script[i] === '\\' && i + 1 < script.length) {
          // Keep the escape; a `\<delim>` becomes a literal delim in the field.
          if (script[i + 1] === delim) { f += delim; i += 2; continue; }
          f += script[i] + script[i + 1];
          i += 2;
          continue;
        }
        f += script[i];
        i++;
      }
      if (script[i] !== delim) throw new Error('unterminated `s\' command');
      i++;
      return f;
    };
    const pattern = readField();
    const replacement = readField();
    // Flags up to a separator (`;`, newline, or a closing brace).
    let flags = '';
    while (i < script.length && script[i] !== ';' && script[i] !== '\n' && script[i] !== '}') {
      flags += script[i];
      i++;
    }
    const global = /g/.test(flags);
    const ignoreCase = /[iI]/.test(flags);
    const print = /p/.test(flags);
    const nthMatch = flags.match(/(\d+)/);
    const nth = nthMatch ? Number(nthMatch[1]) : 0;
    // An empty pattern (`s//repl/`) reuses the last regex at execution time.
    const re = pattern === ''
      ? undefined
      : compilePattern(pattern, { syntax: this.#syntax, flags: 'g' + (ignoreCase ? 'i' : '') });
    return { cmd: { ...spec, type: 's', re, ignoreCase, replacement, global, nth, print }, next: i };
  }

  #parseTransliterate(script: string, i: number, spec: AddressSpec): { cmd: Command; next: number } {
    const delim = script[i];
    if (delim === undefined) throw new Error('unterminated `y\' command');
    i++;
    const readField = (): string => {
      let f = '';
      while (i < script.length && script[i] !== delim) {
        if (script[i] === '\\' && i + 1 < script.length) {
          const nx = script[i + 1];
          if (nx === delim) f += delim;
          else if (nx === 'n') f += '\n';
          else if (nx === 't') f += '\t';
          else if (nx === '\\') f += '\\';
          else f += nx;
          i += 2;
          continue;
        }
        f += script[i];
        i++;
      }
      if (script[i] !== delim) throw new Error('unterminated `y\' command');
      i++;
      return f;
    };
    const from = readField();
    const to = readField();
    if (from.length !== to.length) throw new Error('`y\' strings have different lengths');
    return { cmd: { ...spec, type: 'y', from, to }, next: i };
  }
}

// ── execution ──────────────────────────────────────────────────────────────────

/** Build the replacement string for one match: `&` = whole, `\1..\9` = groups. */
function buildReplacement(replacement: string, m: RegExpExecArray): string {
  let out = '';
  let i = 0;
  while (i < replacement.length) {
    const c = replacement[i];
    if (c === '&') { out += m[0]; i++; continue; }
    if (c === '\\' && i + 1 < replacement.length) {
      const nx = replacement[i + 1];
      if (nx >= '0' && nx <= '9') { out += m[Number(nx)] ?? ''; i += 2; continue; }
      if (nx === 'n') { out += '\n'; i += 2; continue; }
      if (nx === 't') { out += '\t'; i += 2; continue; }
      if (nx === '&') { out += '&'; i += 2; continue; }
      if (nx === '\\') { out += '\\'; i += 2; continue; }
      out += nx;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function applySubst(line: string, cmd: Subst, st: ExecState): { result: string; changed: boolean } {
  // Resolve the (possibly empty `//`) pattern; an empty pattern reuses the last
  // regex but applies this command's own flags (g/i). We always need a `g` copy
  // so we can walk occurrences ourselves.
  const base = resolveRegex(cmd.re, st);
  const flags = base.flags.includes('g') ? base.flags : base.flags + 'g';
  const re = cmd.re ? base : new RegExp(base.source, flags);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let occurrence = 0;
  let changed = false;
  // Which occurrences to replace: if nth>0, replace nth (and onward if global);
  // else first only (unless global → all).
  const minOcc = cmd.nth > 0 ? cmd.nth : 1;
  let prevEnd = -1; // end index of the previous (replaced) match, for zero-width guard
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    // Skip an empty match immediately adjacent to a previous match's end: e.g.
    // `s/a*/-/g` on `aaa` must not fire a second empty match at position 3.
    if (m[0].length === 0 && matchStart === prevEnd) {
      re.lastIndex++;
      if (re.lastIndex > line.length) break;
      continue;
    }
    occurrence++;
    const replace = occurrence >= minOcc && (cmd.global || occurrence === minOcc);
    if (replace) {
      out += line.slice(last, matchStart) + buildReplacement(cmd.replacement, m);
      last = matchEnd;
      changed = true;
      prevEnd = matchEnd;
      if (!cmd.global) break;
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  out += line.slice(last);
  return { result: out, changed };
}

function transliterate(line: string, from: string, to: string): string {
  let out = '';
  for (const ch of line) {
    const idx = from.indexOf(ch);
    out += idx >= 0 ? to[idx] : ch;
  }
  return out;
}

/** Per-(command,scope) range tracking: whether the range is currently active. */
interface RangeState {
  active: boolean;
  /** For `+N` / line ends, the input line number at which the range closes. */
  endLine: number;
  /** `0,/re/` only: set once the range has opened so it never re-opens. */
  started?: boolean;
}

/** Whether a single address matches the current line. */
function matchOne(a: Address, lineno: number, line: string, lastLineno: number, st: ExecState): boolean {
  switch (a.kind) {
    case 'line': return lineno === a.n;
    case 'last': return lineno === lastLineno;
    case 'regex': return resolveRegex(a.re, st).test(line);
    case 'step':
      // GNU `first~step`: matches first, first+step, first+2*step … For step<=0
      // GNU treats it as a plain `first` line address.
      if (a.step <= 0) return lineno === a.first;
      return lineno >= a.first && (lineno - a.first) % a.step === 0;
  }
}

/**
 * Decide whether `spec` selects the current line. Range state mutates `rng`.
 * Negation is applied after the range/address decision.
 */
function addressActive(
  spec: AddressSpec,
  lineno: number,
  line: string,
  lastLineno: number,
  rng: RangeState,
  st: ExecState,
): boolean {
  let result: boolean;
  if (!spec.start) {
    result = true;
  } else if (!spec.end) {
    result = matchOne(spec.start, lineno, line, lastLineno, st);
  } else {
    result = rangeActive(spec, lineno, line, lastLineno, rng, st);
  }
  return spec.negate ? !result : result;
}

function rangeActive(
  spec: AddressSpec,
  lineno: number,
  line: string,
  lastLineno: number,
  rng: RangeState,
  st: ExecState,
): boolean {
  const end = spec.end!;
  const start = spec.start!;
  // GNU `0,/re/`: the range is active from the very first line and may end on
  // the FIRST line that matches the end regex (including line 1 itself).
  const zeroStart = start.kind === 'line' && start.n === 0;
  if (!rng.active) {
    // A `0,/re/` range opens at most once: after it closes it never re-opens.
    if (zeroStart && !rng.started) {
      rng.started = true;
      // Activate without requiring a start match; fall through to test the end
      // on this very line below.
      rng.active = true;
      rng.endLine = -1;
      if (end.kind === 'line' || end.kind === 'plus' || end.kind === 'multiple') {
        // Numeric end relative to line 0: behaves like a plain `1,N` range.
        if (end.kind === 'line') { if (end.n <= lineno) rng.active = false; else rng.endLine = end.n; }
      } else if (matchOne(end, lineno, line, lastLineno, st)) {
        rng.active = false;
      }
      return true;
    }
    if (!matchOne(start, lineno, line, lastLineno, st)) return false;
    rng.active = true;
    // Establish where this range closes.
    if (end.kind === 'line') {
      if (end.n <= lineno) rng.active = false; // already past → single line
      else rng.endLine = end.n;
    } else if (end.kind === 'plus') {
      if (end.n <= 0) rng.active = false;
      else rng.endLine = lineno + end.n;
    } else if (end.kind === 'multiple') {
      // `addr,~N`: ends at the next line that is a multiple of N (>= current+1).
      if (end.n <= 0) { rng.active = false; }
      else {
        let e = lineno - (lineno % end.n) + end.n;
        if (e <= lineno) e += end.n;
        rng.endLine = e;
      }
    } else {
      rng.endLine = -1; // regex / last → checked by matching, not a number
    }
    return true;
  }
  // Inside the range: this line is included; decide whether it ends here.
  if (end.kind === 'line' || end.kind === 'plus' || end.kind === 'multiple') {
    if (rng.endLine >= 0 && lineno >= rng.endLine) rng.active = false;
  } else if (matchOne(end, lineno, line, lastLineno, st)) {
    rng.active = false;
  }
  return true;
}

interface ApplyResult {
  output: string;
  quit: boolean;
  /** Exit code requested by `q`/`Q` (default 0). */
  code: number;
}

/** Mutable per-run execution state shared across cycles. */
interface ExecState {
  hold: string;
  /** Set when any `s///` succeeds; cleared on a new input line or a `t`/`T`. */
  substMade: boolean;
  /** The most recently *used* regex (from an address or s///); `//` reuses it. */
  lastRegex?: RegExp;
}

/** Resolve a (possibly empty `//`) regex against the last-used one, recording
 * the resolved regex as the new "last regex" for subsequent `//` references. */
function resolveRegex(re: RegExp | undefined, st: ExecState): RegExp {
  const r = re ?? st.lastRegex;
  if (r === undefined) throw new Error('no previous regular expression');
  st.lastRegex = r;
  return r;
}

function applyScript(text: string, cmds: Command[], suppress: boolean): ApplyResult {
  const hasTrailing = text.endsWith('\n');
  const lines = text === '' ? [] : (hasTrailing ? text.slice(0, -1) : text).split('\n');
  const lastLineno = lines.length;
  const ranges: RangeState[] = cmds.map(() => ({ active: false, endLine: -1 }));

  // Map label name → command index for branch targets.
  const labels = new Map<string, number>();
  for (let ci = 0; ci < cmds.length; ci++) {
    const cmd = cmds[ci];
    if (cmd.type === ':') labels.set(cmd.label, ci);
  }

  const st: ExecState = { hold: '', substMade: false };
  const outParts: string[] = [];
  let quit = false;
  let quitCode = 0;

  // Emit a finished line into output, honoring the input's trailing-newline
  // convention only for the final input line.
  const emitLine = (s: string, isLastInput: boolean): void => {
    if (isLastInput && !hasTrailing) outParts.push(s);
    else outParts.push(s + '\n');
  };
  // Auxiliary output (p, =, a/i/c, etc.) always carries a newline.
  const emitAux = (s: string): void => { outParts.push(s + '\n'); };

  // Pointer-based reader so `N`/`n` can pull the next input line.
  let lineIdx = 0;
  const nextInput = (): string | undefined => (lineIdx < lines.length ? lines[lineIdx++] : undefined);

  // `pattern`/`lineno` are the live pattern space. A `D` restart re-enters the
  // cycle loop WITHOUT consuming new input by leaving `carry` set.
  let pattern = '';
  let lineno = 0;
  let carry: string | null = null;

  while (true) {
    if (carry !== null) {
      // `D` restart: reuse the remaining pattern space and the current line number.
      pattern = carry;
      carry = null;
    } else {
      const s0 = nextInput();
      if (s0 === undefined) break;
      pattern = s0;
      lineno = lineIdx; // 1-based: we just consumed lines[lineIdx-1]
      st.substMade = false;
    }

    // A pattern space is "the last input line" when no further input remains.
    const isLast = (): boolean => lineIdx >= lines.length && carry === null;

    const appendQueue: string[] = [];
    let deleted = false; // suppress the end-of-cycle auto-print
    let pc = 0;
    let restart = false; // `D` requested a cycle restart with the carried pattern

    // Inner program-counter loop over the command list.
    while (pc < cmds.length) {
      const cmd = cmds[pc];
      if (cmd.type === '}') { pc++; continue; }
      if (cmd.type === ':') { pc++; continue; }

      const active = addressActive(cmd, lineno, pattern, lastLineno, ranges[pc], st);

      if (cmd.type === '{') {
        // Address-gated block: enter when active, else jump past the matching `}`.
        if (active) pc++;
        else pc = cmd.close + 1;
        continue;
      }

      if (!active) { pc++; continue; }

      switch (cmd.type) {
        case 's': {
          const r = applySubst(pattern, cmd, st);
          pattern = r.result;
          if (r.changed) { st.substMade = true; if (cmd.print) emitLine(pattern, isLast()); }
          break;
        }
        case 'p': emitLine(pattern, isLast()); break;
        case 'P': {
          const nl = pattern.indexOf('\n');
          // `P` prints only the first line of the pattern space; it carries a
          // newline unless this is the last input line without a trailing one.
          if (nl >= 0) emitAux(pattern.slice(0, nl));
          else emitLine(pattern, isLast());
          break;
        }
        case 'd': deleted = true; break;
        case 'D': {
          const nl = pattern.indexOf('\n');
          if (nl < 0) { deleted = true; break; }
          // Delete up to and including the first newline; restart the cycle on
          // the remaining pattern space WITHOUT reading new input.
          carry = pattern.slice(nl + 1);
          restart = true;
          deleted = true; // no auto-print of the consumed portion
          break;
        }
        case 'q': quit = true; quitCode = cmd.code; break;
        case 'Q':
          // Quit immediately WITHOUT auto-printing the current pattern space.
          quit = true; quitCode = cmd.code; deleted = true;
          break;
        case '=': emitAux(String(lineno)); break;
        case 'y': pattern = transliterate(pattern, cmd.from, cmd.to); break;
        case 'a': appendQueue.push(cmd.text); break;
        case 'i': emitAux(cmd.text); break;
        case 'c': {
          // GNU `c`: on a single address (or a non-range) emit the text and
          // delete the line. On a RANGE, emit once at the END of the range only
          // — i.e. only when the range has just closed (`ranges[pc].active` is
          // false after `addressActive` evaluated this line). `c` ALSO ends the
          // current cycle: no commands after it run on the (deleted) pattern.
          deleted = true;
          const isRange = cmd.end !== undefined;
          if (!isRange || !ranges[pc].active) emitAux(cmd.text);
          pc = cmds.length; // end the cycle
          continue;
        }
        case 'h': st.hold = pattern; break;
        case 'H': st.hold = st.hold + '\n' + pattern; break;
        case 'g': pattern = st.hold; break;
        case 'G': pattern = pattern + '\n' + st.hold; break;
        case 'x': { const t = pattern; pattern = st.hold; st.hold = t; break; }
        case 'n': {
          // Print current pattern (unless -n), then load the next input line.
          if (!suppress) emitLine(pattern, isLast());
          for (const a of appendQueue) emitAux(a);
          appendQueue.length = 0;
          const nx = nextInput();
          if (nx === undefined) { deleted = true; quit = true; break; }
          pattern = nx;
          lineno = lineIdx;
          break;
        }
        case 'N': {
          const nx = nextInput();
          if (nx === undefined) {
            // GNU: at EOF, fall through to end the cycle (the pattern space is
            // still auto-printed unless -n). POSIX would discard; we follow GNU.
            break;
          }
          pattern = pattern + '\n' + nx;
          lineno = lineIdx;
          break;
        }
        case 'b': {
          if (cmd.label === '') { pc = cmds.length; continue; }
          const t = labels.get(cmd.label);
          if (t === undefined) throw new Error(`can't find label for jump to \`${cmd.label}'`);
          pc = t;
          continue;
        }
        case 't': {
          if (st.substMade) {
            st.substMade = false;
            if (cmd.label === '') { pc = cmds.length; continue; }
            const t = labels.get(cmd.label);
            if (t === undefined) throw new Error(`can't find label for jump to \`${cmd.label}'`);
            pc = t;
            continue;
          }
          break;
        }
        case 'T': {
          if (!st.substMade) {
            if (cmd.label === '') { pc = cmds.length; continue; }
            const t = labels.get(cmd.label);
            if (t === undefined) throw new Error(`can't find label for jump to \`${cmd.label}'`);
            pc = t;
            continue;
          }
          st.substMade = false;
          break;
        }
      }

      if (restart) break;
      if (deleted && cmd.type === 'd') break;
      if (quit) break;
      pc++;
    }

    if (restart) {
      // Flush any queued appends from this pass, then re-run with the carry.
      for (const a of appendQueue) emitAux(a);
      continue;
    }

    if (!deleted && !suppress) emitLine(pattern, isLast());
    for (const a of appendQueue) emitAux(a);
    if (quit) break;
  }

  return { output: outParts.join(''), quit, code: quitCode };
}

// ── file I/O ────────────────────────────────────────────────────────────────────

async function readFileText(io: CommandIO, path: string): Promise<string> {
  const { fd } = (await io.syscall('fs/open', { dirfd: -100, path, oflags: {} })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(buf);
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

async function writeFileText(io: CommandIO, path: string, content: string): Promise<void> {
  const { fd } = (await io.syscall('fs/open', {
    dirfd: -100, path, oflags: { write: true, create: true, truncate: true },
  })) as { fd: number };
  try {
    const bytes = new TextEncoder().encode(content);
    let written = 0;
    while (written < bytes.byteLength) {
      const r = (await io.syscall('fs/write', { fd, data: bytes.subarray(written) })) as { written: number };
      if (!r || r.written <= 0) break;
      written += r.written;
    }
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

const sedCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'sed';
  const cfg = parseSedArgs(io.args.slice(1));
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const enc = new TextEncoder();

  try {
    if (cfg.expressions.length === 0) {
      await writeLine(err, `${name}: no script specified`);
      return 1;
    }
    const script = cfg.expressions.join('\n');
    let cmds: Command[];
    try {
      cmds = new ScriptParser(cfg.syntax).parse(script);
    } catch (e) {
      await writeLine(err, `${name}: -e expression: ${(e as Error).message}`);
      return 1;
    }

    if (cfg.files.length === 0) {
      const text = await readAllText(io.stdin);
      let r: ApplyResult;
      try {
        r = applyScript(text, cmds, cfg.suppress);
      } catch (e) {
        await writeLine(err, `${name}: ${(e as Error).message}`);
        return 1;
      }
      await writeBytes(out, enc.encode(r.output));
      return r.code;
    }

    let exitCode = 0;
    for (const path of cfg.files) {
      let text: string;
      try {
        text = await readFileText(io, path);
      } catch {
        await writeLine(err, `${name}: can't read ${path}: No such file or directory`);
        exitCode = 2;
        continue;
      }
      let r: ApplyResult;
      try {
        r = applyScript(text, cmds, cfg.suppress);
      } catch (e) {
        await writeLine(err, `${name}: ${(e as Error).message}`);
        return 1;
      }
      if (cfg.inPlace) {
        try {
          await writeFileText(io, path, r.output);
        } catch (e) {
          await writeLine(err, `${name}: couldn't write ${path}: ${(e as Error).message}`);
          exitCode = 2;
        }
      } else {
        await writeBytes(out, enc.encode(r.output));
      }
      // `q`/`Q` stops processing further files and sets the exit code.
      if (r.quit) { if (r.code !== 0) exitCode = r.code; break; }
    }
    return exitCode;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(sedCommand);
export { sedCommand };

/**
 * `sed` — stream editor (subset with full GNU parity on the common path).
 *
 * Flags: `-e SCRIPT` (repeatable), `-n` quiet, `-E`/`-r` ERE, `-i` in-place
 * (write the result back to the VFS file). Multiple files.
 *
 * Addresses: line `N`, last line `$`, regex `/re/`, ranges `N,M` and
 * `/re1/,/re2/`. A range starts when its first address matches and stays active
 * through the line where the second matches (GNU semantics).
 *
 * Commands: `s/pat/repl/flags` (flags `g` global, `i`/`I` ignore-case, `p`
 * print, and a numeric Nth-occurrence), with `&` (whole match) and `\1..\9`
 * (capture groups) in the replacement; `p` print, `d` delete, `q` quit,
 * `=` print line number, `a TEXT` append, `i TEXT` insert, `c TEXT` change,
 * `y/abc/xyz/` transliterate.
 *
 * Regex syntax defaults to BRE; `-E`/`-r` selects ERE (see `_regex.ts` for the
 * honest BRE↔ERE translation). `.` does not match newline (sed pattern space is
 * normally one line).
 */
import { defineCommand, readAllText, writeBytes, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { compilePattern } from './_regex.ts';
import type { RegexSyntax } from './_regex.ts';

// ── address & command model ──────────────────────────────────────────────────

type Address =
  | { kind: 'line'; n: number }
  | { kind: 'last' }
  | { kind: 'regex'; re: RegExp };

interface AddressSpec {
  /** undefined = every line; one = single address; two = range. */
  start?: Address;
  end?: Address;
}

interface Subst {
  type: 's';
  re: RegExp; // compiled with 'g' always; we control occurrence ourselves
  replacement: string;
  global: boolean;
  nth: number; // replace the Nth occurrence (1-based); 0 = first only unless global
  print: boolean; // s///p
}

type Command =
  | (AddressSpec & Subst)
  | (AddressSpec & { type: 'p' })
  | (AddressSpec & { type: 'd' })
  | (AddressSpec & { type: 'q' })
  | (AddressSpec & { type: '=' })
  | (AddressSpec & { type: 'a'; text: string })
  | (AddressSpec & { type: 'i'; text: string })
  | (AddressSpec & { type: 'c'; text: string })
  | (AddressSpec & { type: 'y'; from: string; to: string });

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

  /** Parse the joined script text into a list of commands. */
  parse(script: string): Command[] {
    const cmds: Command[] = [];
    let i = 0;
    const n = script.length;
    while (i < n) {
      // Skip separators / whitespace between commands.
      while (i < n && (script[i] === ';' || script[i] === '\n' || script[i] === ' ' || script[i] === '\t')) i++;
      if (i >= n) break;
      const r = this.#parseOne(script, i);
      cmds.push(r.cmd);
      i = r.next;
    }
    return cmds;
  }

  #parseAddress(script: string, i: number): { addr?: Address; next: number } {
    const c = script[i];
    if (c === '$') return { addr: { kind: 'last' }, next: i + 1 };
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < script.length && script[j] >= '0' && script[j] <= '9') j++;
      return { addr: { kind: 'line', n: Number(script.slice(i, j)) }, next: j };
    }
    if (c === '/') {
      let j = i + 1;
      let pat = '';
      while (j < script.length && script[j] !== '/') {
        if (script[j] === '\\' && j + 1 < script.length) { pat += script[j] + script[j + 1]; j += 2; continue; }
        pat += script[j];
        j++;
      }
      if (script[j] !== '/') throw new Error('unterminated address regex');
      return { addr: { kind: 'regex', re: this.#compile(pat) }, next: j + 1 };
    }
    return { next: i };
  }

  #parseOne(script: string, start: number): { cmd: Command; next: number } {
    let i = start;
    const spec: AddressSpec = {};
    const a1 = this.#parseAddress(script, i);
    if (a1.addr) {
      spec.start = a1.addr;
      i = a1.next;
      if (script[i] === ',') {
        i++;
        const a2 = this.#parseAddress(script, i);
        if (!a2.addr) throw new Error('expected second address');
        spec.end = a2.addr;
        i = a2.next;
      }
    }
    while (script[i] === ' ' || script[i] === '\t') i++;
    const cmdChar = script[i];
    if (cmdChar === undefined) throw new Error('missing command');
    i++;
    switch (cmdChar) {
      case 's': return this.#parseSubst(script, i, spec);
      case 'y': return this.#parseTransliterate(script, i, spec);
      case 'p': return { cmd: { ...spec, type: 'p' }, next: i };
      case 'd': return { cmd: { ...spec, type: 'd' }, next: i };
      case 'q': return { cmd: { ...spec, type: 'q' }, next: i };
      case '=': return { cmd: { ...spec, type: '=' }, next: i };
      case 'a': case 'i': case 'c': {
        const t = this.#parseText(script, i);
        return { cmd: { ...spec, type: cmdChar, text: t.text }, next: t.next };
      }
      default:
        throw new Error(`unknown command: \`${cmdChar}'`);
    }
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
    // Flags up to a separator.
    let flags = '';
    while (i < script.length && script[i] !== ';' && script[i] !== '\n') {
      flags += script[i];
      i++;
    }
    const global = /g/.test(flags);
    const ignoreCase = /[iI]/.test(flags);
    const print = /p/.test(flags);
    const nthMatch = flags.match(/(\d+)/);
    const nth = nthMatch ? Number(nthMatch[1]) : 0;
    const re = compilePattern(pattern, { syntax: this.#syntax, flags: 'g' + (ignoreCase ? 'i' : '') });
    return { cmd: { ...spec, type: 's', re, replacement, global, nth, print }, next: i };
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

function applySubst(line: string, cmd: Subst): { result: string; changed: boolean } {
  cmd.re.lastIndex = 0;
  let out = '';
  let last = 0;
  let occurrence = 0;
  let changed = false;
  // Which occurrences to replace: if nth>0, replace nth (and onward if global);
  // else first only (unless global → all).
  const minOcc = cmd.nth > 0 ? cmd.nth : 1;
  let m: RegExpExecArray | null;
  while ((m = cmd.re.exec(line)) !== null) {
    occurrence++;
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    const replace = occurrence >= minOcc && (cmd.global || occurrence === minOcc);
    if (replace) {
      out += line.slice(last, matchStart) + buildReplacement(cmd.replacement, m);
      last = matchEnd;
      changed = true;
      if (!cmd.global) break;
    }
    if (m[0].length === 0) cmd.re.lastIndex++;
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

/** Tracks whether each ranged command is currently "inside" its range. */
interface RangeState { active: boolean }

function addressActive(
  spec: AddressSpec,
  lineno: number,
  line: string,
  lastLineno: number,
  rng: RangeState,
): boolean {
  if (!spec.start) return true;
  const matchOne = (a: Address): boolean => {
    if (a.kind === 'line') return lineno === a.n;
    if (a.kind === 'last') return lineno === lastLineno;
    return a.re.test(line);
  };
  if (!spec.end) return matchOne(spec.start);
  // Range semantics.
  if (!rng.active) {
    if (matchOne(spec.start)) {
      rng.active = true;
      // A numeric end already passed → single line only.
      if (spec.end.kind === 'line' && spec.end.n <= lineno) rng.active = false;
      return true;
    }
    return false;
  }
  // Inside the range: this line is included; check whether the range ends here.
  if (matchOne(spec.end)) rng.active = false;
  return true;
}

interface ApplyResult {
  output: string;
  quit: boolean;
}

function applyScript(text: string, cmds: Command[], suppress: boolean): ApplyResult {
  const hasTrailing = text.endsWith('\n');
  const lines = text === '' ? [] : (hasTrailing ? text.slice(0, -1) : text).split('\n');
  const lastLineno = lines.length;
  const ranges: RangeState[] = cmds.map(() => ({ active: false }));

  let out = '';
  let quit = false;
  const emit = (s: string): void => { out += s + '\n'; };

  for (let idx = 0; idx < lines.length; idx++) {
    const lineno = idx + 1;
    let s = lines[idx];
    let deleted = false;
    const appendQueue: string[] = [];

    for (let ci = 0; ci < cmds.length; ci++) {
      const cmd = cmds[ci];
      if (!addressActive(cmd, lineno, s, lastLineno, ranges[ci])) continue;
      switch (cmd.type) {
        case 's': {
          const r = applySubst(s, cmd);
          s = r.result;
          if (r.changed && cmd.print) emit(s);
          break;
        }
        case 'p': emit(s); break;
        case 'd': deleted = true; break;
        case 'q': quit = true; break;
        case '=': emit(String(lineno)); break;
        case 'y': s = transliterate(s, cmd.from, cmd.to); break;
        case 'a': appendQueue.push(cmd.text); break;
        case 'i': emit(cmd.text); break;
        case 'c':
          // GNU `c` deletes the line(s); for a range it prints text once at the
          // end of the range. We approximate the common single-address case:
          // delete the line and emit the text in its place.
          deleted = true;
          emit(cmd.text);
          break;
      }
      if (deleted && cmd.type === 'd') break;
      if (quit) break;
    }

    if (!deleted && !suppress) {
      // Preserve the original trailing-newline behavior for the last line.
      if (lineno === lastLineno && !hasTrailing) out += s;
      else out += s + '\n';
    }
    for (const a of appendQueue) emit(a);
    if (quit) break;
  }
  return { output: out, quit };
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
      const r = applyScript(text, cmds, cfg.suppress);
      await writeBytes(out, enc.encode(r.output));
      return 0;
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
      const r = applyScript(text, cmds, cfg.suppress);
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
    }
    return exitCode;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(sedCommand);
export { sedCommand };

/**
 * jq command-line option parsing and output formatting — the glue between the
 * pure {@link import('./engine.ts').compile} engine and a process's argv/stdio.
 *
 * {@link parseJqArgs} turns argv into a {@link JqOptions} (flags + filter
 * program + named args), and {@link formatOutput} renders one engine output
 * value according to `-r/-c/-j/-a/--tab/--indent/-S`. The actual stdio wiring
 * lives in {@link import('./jq.ts')}.
 */
import { toJSON, toStr } from './values.ts';

export interface JqOptions {
  /** The filter program (first non-flag operand). Defaults to `.`. */
  program: string;
  /** Named args from --arg/--argjson, bound as $name. */
  args: Record<string, unknown>;
  raw: boolean; // -r: raw string output
  compact: boolean; // -c
  nullInput: boolean; // -n
  slurp: boolean; // -s
  rawInput: boolean; // -R
  exitStatus: boolean; // -e
  join: boolean; // -j: -r + no newline between outputs
  tab: boolean; // --tab
  indent: number; // --indent N (default 2)
  asciiOutput: boolean; // -a
  sortKeys: boolean; // -S
  /** Positional non-flag operands AFTER the program (file args; unused in pipe). */
  files: string[];
}

/** Parse a jq-style argv (excluding argv[0]) into {@link JqOptions}. */
export function parseJqArgs(argv: string[]): JqOptions {
  const o: JqOptions = {
    program: '', args: {}, raw: false, compact: false, nullInput: false, slurp: false,
    rawInput: false, exitStatus: false, join: false, tab: false, indent: 2,
    asciiOutput: false, sortKeys: false, files: [],
  };
  let programSeen = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (let j = i + 1; j < argv.length; j++) { if (!programSeen) { o.program = argv[j]; programSeen = true; } else o.files.push(argv[j]); } break; }
    if (a === '--arg') { const name = argv[++i]; const val = argv[++i]; o.args[name] = val; continue; }
    if (a === '--argjson') { const name = argv[++i]; const val = argv[++i]; o.args[name] = JSON.parse(val); continue; }
    if (a === '--tab') { o.tab = true; continue; }
    if (a === '--indent') { o.indent = Number(argv[++i]); continue; }
    if (a === '--raw-output') { o.raw = true; continue; }
    if (a === '--compact-output') { o.compact = true; continue; }
    if (a === '--null-input') { o.nullInput = true; continue; }
    if (a === '--slurp') { o.slurp = true; continue; }
    if (a === '--raw-input') { o.rawInput = true; continue; }
    if (a === '--ascii-output') { o.asciiOutput = true; continue; }
    if (a === '--sort-keys') { o.sortKeys = true; continue; }
    if (a === '--join-output') { o.join = true; o.raw = true; continue; }
    if (a === '--exit-status') { o.exitStatus = true; continue; }
    if (a.startsWith('--')) { continue; /* unknown long flag: ignore */ }

    if (a.startsWith('-') && a.length > 1 && a !== '-') {
      // short flag cluster
      for (const ch of a.slice(1)) {
        switch (ch) {
          case 'r': o.raw = true; break;
          case 'c': o.compact = true; break;
          case 'n': o.nullInput = true; break;
          case 's': o.slurp = true; break;
          case 'R': o.rawInput = true; break;
          case 'e': o.exitStatus = true; break;
          case 'j': o.join = true; o.raw = true; break;
          case 'a': o.asciiOutput = true; break;
          case 'S': o.sortKeys = true; break;
          default: break; // ignore unknowns
        }
      }
      continue;
    }

    // positional
    if (!programSeen) { o.program = a; programSeen = true; }
    else o.files.push(a);
  }

  if (!programSeen) o.program = '.';
  return o;
}

/** Render one engine output value to its on-the-wire string (no trailing NL). */
export function formatOutput(value: unknown, o: JqOptions): string {
  if (o.raw && typeof value === 'string') {
    return o.asciiOutput ? asciiEscapeRaw(value) : value;
  }
  const indent = o.compact ? 0 : (o.tab ? '\t' : o.indent);
  let s = toJSON(value, indent, o.sortKeys);
  if (o.asciiOutput) s = asciiEscape(s);
  return s;
}

// Escape every non-ASCII code unit to \uXXXX (for -a / --ascii-output).
function asciiEscape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp > 0x7f) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += s[i];
  }
  return out;
}
function asciiEscapeRaw(s: string): string { return asciiEscape(s); }

/** Parse the (possibly multi-value) JSON input stream a jq invocation reads. */
export function parseInputs(text: string, o: JqOptions): unknown[] {
  if (o.rawInput) {
    if (o.slurp) return [text];
    // one string per line (drop a single trailing newline)
    const t = text.endsWith('\n') ? text.slice(0, -1) : text;
    return t === '' ? [] : t.split('\n');
  }
  const values = parseJsonStream(text);
  if (o.slurp) return [values];
  return values;
}

/** Parse a whitespace-separated stream of JSON values (jq's default input). */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const [val, next] = parseOneJson(text, i);
    out.push(val);
    i = next;
  }
  return out;
}

// Parse one JSON value starting at `i`, returning [value, indexAfter].
function parseOneJson(text: string, i: number): [unknown, number] {
  // Find the extent of a single JSON value by tracking nesting + strings.
  let depth = 0;
  let inStr = false;
  const start = i;
  let j = i;
  const n = text.length;
  // scalars (number/true/false/null) without braces: read until whitespace
  const c = text[i];
  if (c !== '{' && c !== '[' && c !== '"') {
    while (j < n && !/\s/.test(text[j]) && text[j] !== ',') j++;
    return [JSON.parse(text.slice(start, j)), j];
  }
  // top-level string: scan to the matching closing quote.
  if (c === '"') {
    j = i + 1;
    while (j < n) { if (text[j] === '\\') { j += 2; continue; } if (text[j] === '"') { j++; break; } j++; }
    return [JSON.parse(text.slice(start, j)), j];
  }
  for (; j < n; j++) {
    const ch = text[j];
    if (inStr) { if (ch === '\\') { j++; continue; } if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { j++; break; } }
  }
  return [JSON.parse(text.slice(start, j)), j];
}

export { toStr };

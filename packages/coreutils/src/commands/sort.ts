/**
 * `sort` — sort lines of text.
 *
 * Supported:
 *   - `-n` numeric, `-r` reverse, `-u` unique (drop adjacent equal after sort).
 *   - `-f` fold case, `-b` ignore leading blanks.
 *   - `-t SEP` field separator, `-k N` key (1-based field; `N.M` start col;
 *     `N,M` end field supported). Key may carry per-key flags (e.g. `-k2,2n`).
 *   - multiple files concatenated; `-` (or none) reads stdin.
 *   - stable sort (preserves input order for equal keys).
 */
import { defineCommand, parseArgs, readLines, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFileLines(io: CommandIO, path: string): Promise<string[]> {
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
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
    const text = new TextDecoder().decode(buf);
    if (text === '') return [];
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    return body.split('\n');
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

interface KeySpec {
  startField: number;
  startChar: number;
  endField?: number;
  endChar?: number;
  numeric?: boolean;
  reverse?: boolean;
  fold?: boolean;
  ignoreBlanks?: boolean;
}

/**
 * Parse a `-k` spec like `2`, `2.3`, `2,4`, `2,2n`, `2,2r`, `1.1,1.3`. Per-key
 * trailing flags (`n` numeric, `r` reverse, `f` fold case, `b` ignore leading
 * blanks) may appear on the start and/or end position and apply to the key.
 */
export function parseKey(spec: string): KeySpec {
  const [start, end] = spec.split(',');
  const parse = (s: string): { field: number; char: number; flags: string } => {
    const m = /^([0-9]+)(?:\.([0-9]+))?([a-zA-Z]*)$/.exec(s);
    if (!m) return { field: 1, char: 0, flags: '' };
    return { field: Number(m[1]), char: m[2] ? Number(m[2]) : 0, flags: m[3] ?? '' };
  };
  const s = parse(start);
  const flags = s.flags + (end !== undefined ? parse(end).flags : '');
  const result: KeySpec = {
    startField: s.field,
    startChar: s.char > 0 ? s.char : 1,
  };
  if (end !== undefined) {
    const e = parse(end);
    result.endField = e.field;
    // End char 0 (no `.C`) means "through the end of the end field".
    if (e.char > 0) result.endChar = e.char;
  }
  if (flags.includes('n')) result.numeric = true;
  if (flags.includes('r')) result.reverse = true;
  if (flags.includes('f')) result.fold = true;
  if (flags.includes('b')) result.ignoreBlanks = true;
  return result;
}

/** Collect every `-k VALUE` / `-kVALUE` / `--key=VALUE` / `--key VALUE` from
 * argv, in order, so multiple keys are all honored. */
function collectKeys(argv: string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (a === '-k' || a === '--key') { if (argv[i + 1] !== undefined) keys.push(argv[++i]); }
    else if (a.startsWith('--key=')) keys.push(a.slice('--key='.length));
    else if (a.startsWith('-k') && a.length > 2) keys.push(a.slice(2));
  }
  return keys;
}

/** Extract a key's text given separator and key spec. */
function extractKey(line: string, key: KeySpec, sep: string | undefined): string {
  // With an explicit `-t SEP`, split on it. Otherwise GNU treats runs of
  // whitespace as the separator (a leading blank run is not its own field).
  const parts = sep !== undefined ? line.split(sep) : splitWhitespaceFields(line);
  const startIdx = key.startField - 1;
  const endIdx = key.endField !== undefined ? key.endField : parts.length;
  if (startIdx >= parts.length) return '';
  const joiner = sep !== undefined ? sep : ' ';
  const slice = parts.slice(startIdx, Math.max(startIdx, endIdx));
  let text = slice.join(joiner);
  // `endChar` limits the span within the end field; we approximate by trimming
  // the joined text to (endField span up to endChar). For the common single
  // field case this is exact.
  if (key.endChar !== undefined && key.endField !== undefined) {
    // Recompute relative to the start of the slice: chars are counted within
    // the end field's text. For a single-field key this is the simple case.
    if (key.startField === key.endField) {
      text = text.slice(0, key.endChar);
    }
  }
  if (key.startChar > 1) text = text.slice(key.startChar - 1);
  return text;
}

function splitWhitespaceFields(line: string): string[] {
  // GNU sort: each field is preceded by its separating blanks; emulate with a
  // simple split on runs of whitespace, ignoring a leading blank run.
  return line.replace(/^\s+/, '').split(/\s+/);
}

function compareValues(a: string, b: string, numeric: boolean, fold: boolean): number {
  if (numeric) {
    const na = parseFloat(a); const nb = parseFloat(b);
    const va = Number.isNaN(na) ? 0 : na;
    const vb = Number.isNaN(nb) ? 0 : nb;
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
  }
  let x = a; let y = b;
  if (fold) { x = x.toUpperCase(); y = y.toUpperCase(); }
  return x < y ? -1 : x > y ? 1 : 0;
}

const sortCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['n', 'r', 'u', 'f', 'b', 'numeric-sort', 'reverse', 'unique', 'ignore-case', 'ignore-leading-blanks'],
    string: ['t', 'k', 'field-separator', 'key'],
    alias: { 'numeric-sort': 'n', reverse: 'r', unique: 'u', 'ignore-case': 'f', 'ignore-leading-blanks': 'b', 'field-separator': 't', key: 'k' },
  });
  const name = io.args[0] ?? 'sort';
  const numeric = Boolean(flags.n);
  const reverse = Boolean(flags.r);
  const unique = Boolean(flags.u);
  const fold = Boolean(flags.f);
  const ignoreBlanks = Boolean(flags.b);
  const sep = flags.t !== undefined ? String(flags.t) : undefined;
  // Collect ALL `-k`/`--key` specs (parseArgs only keeps the last), preserving
  // their order so they apply as primary, secondary, … sort keys.
  const keys = collectKeys(io.args.slice(1)).map(parseKey);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;

  try {
    const sources = positionals.length > 0 ? positionals : ['-'];
    let lines: string[] = [];
    for (const src of sources) {
      if (src === '-') lines = lines.concat(await readLines(io.stdin));
      else {
        try { lines = lines.concat(await readFileLines(io, src)); }
        catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeString(err, `${name}: cannot read: ${src}: ${msg}\n`);
          exitCode = 1;
        }
      }
    }

    // Extract the text for one key, applying its per-key `b` (or the global one).
    const keyText = (line: string, key: KeySpec): string => {
      let k = extractKey(line, key, sep);
      if (key.ignoreBlanks || ignoreBlanks) k = k.replace(/^\s+/, '');
      return k;
    };

    // Compare two lines using the configured keys in order; each key carries its
    // own numeric/fold/reverse. With no `-k`, compare whole lines under the
    // global flags.
    const stripB = (s: string): string => (ignoreBlanks ? s.replace(/^\s+/, '') : s);
    const compareLines = (a: string, b: string): number => {
      if (keys.length === 0) {
        const c = compareValues(stripB(a), stripB(b), numeric, fold);
        return reverse ? -c : c;
      }
      for (const key of keys) {
        const kn = numeric || Boolean(key.numeric);
        const kf = fold || Boolean(key.fold);
        let c = compareValues(keyText(a, key), keyText(b, key), kn, kf);
        if (key.reverse) c = -c;
        if (c !== 0) return reverse ? -c : c;
      }
      // GNU last-resort: whole-line comparison under the global flags.
      const c = compareValues(a, b, false, fold);
      return reverse ? -c : c;
    };

    const decorated = lines.map((line, idx) => ({ line, idx }));
    decorated.sort((a, b) => {
      const c = compareLines(a.line, b.line);
      if (c !== 0) return c;
      return a.idx - b.idx; // stable
    });

    let result = decorated.map((d) => d.line);
    if (unique) {
      // Two adjacent lines are "equal" for `-u` when all keys compare equal
      // (ignoring reverse/index). Reuse compareLines without the global reverse
      // affecting equality (reverse never changes the zero result).
      const seen: string[] = [];
      let prev: string | undefined;
      for (const d of decorated) {
        if (prev === undefined || compareLines(prev, d.line) !== 0) seen.push(d.line);
        prev = d.line;
      }
      result = seen;
    }

    if (result.length > 0) await writeString(out, result.join('\n') + '\n');
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(sortCommand);
export { sortCommand };

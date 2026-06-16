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

interface KeySpec { startField: number; startChar: number; endField?: number; numeric?: boolean; }

/** Parse `-k` like `2`, `2.3`, `2,4`, `2,2n`. Per-key trailing flags: n. */
export function parseKey(spec: string): KeySpec {
  const [start, end] = spec.split(',');
  const parse = (s: string): { field: number; char: number; flags: string } => {
    const m = /^([0-9]+)(?:\.([0-9]+))?([a-z]*)$/.exec(s);
    if (!m) return { field: 1, char: 1, flags: '' };
    return { field: Number(m[1]), char: m[2] ? Number(m[2]) : 1, flags: m[3] ?? '' };
  };
  const s = parse(start);
  const result: KeySpec = { startField: s.field, startChar: s.char, numeric: s.flags.includes('n') };
  if (end !== undefined) {
    const e = parse(end);
    result.endField = e.field;
    if (e.flags.includes('n')) result.numeric = true;
  }
  return result;
}

/** Extract a key's text given separator and key spec. */
function extractKey(line: string, key: KeySpec | undefined, sep: string | undefined): string {
  if (!key) return line;
  // With an explicit `-t SEP`, split on it. Otherwise GNU treats runs of
  // whitespace as the separator (a leading blank run is not its own field).
  const parts = sep !== undefined ? line.split(sep) : splitWhitespaceFields(line);
  const startIdx = key.startField - 1;
  const endIdx = key.endField !== undefined ? key.endField : parts.length;
  if (startIdx >= parts.length) return '';
  const slice = parts.slice(startIdx, endIdx);
  let text = slice.join(sep !== undefined ? sep : ' ');
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
  const key = flags.k !== undefined ? parseKey(String(flags.k)) : undefined;

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

    const keyNumeric = numeric || Boolean(key?.numeric);
    const keyOf = (line: string): string => {
      let k = extractKey(line, key, sep);
      if (ignoreBlanks) k = k.replace(/^\s+/, '');
      return k;
    };

    // Stable sort: decorate with original index, compare keys, tie-break on index.
    const decorated = lines.map((line, idx) => ({ line, idx, key: keyOf(line) }));
    decorated.sort((a, b) => {
      let c = compareValues(a.key, b.key, keyNumeric, fold);
      if (c === 0 && key) {
        // Secondary: whole-line comparison (GNU last-resort), respecting numeric/fold off.
        c = compareValues(a.line, b.line, false, fold);
      }
      if (reverse) c = -c;
      if (c !== 0) return c;
      return a.idx - b.idx; // stable
    });

    let result = decorated.map((d) => d.line);
    if (unique) {
      const seen: string[] = [];
      let prevKey: string | undefined;
      for (const d of decorated) {
        const cmpKey = fold ? d.key.toUpperCase() : d.key;
        if (prevKey === undefined || cmpKey !== prevKey) seen.push(d.line);
        prevKey = cmpKey;
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

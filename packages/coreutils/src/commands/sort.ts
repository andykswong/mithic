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
import { defineCommand, parseArgs, readAll, writeString, optionError, fsErrorText } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Canonical POSIX errno text for an `fs/*` failure (see head.ts for rationale). */
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: 'No such file or directory', EACCES: 'Permission denied', EEXIST: 'File exists',
  ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EXDEV: 'Invalid cross-device link',
  ENOTEMPTY: 'Directory not empty', EINVAL: 'Invalid argument', ENOSPC: 'No space left on device',
  EIO: 'Input/output error',
};
function errnoText(err: unknown): string {
  const code = (err as { code?: string })?.code;
  return (code && ERRNO_TEXT[code]) ?? fsErrorText(err);
}

interface KeySpec {
  startField: number;
  startChar: number;
  endField?: number;
  endChar?: number;
  kind?: SortKind;
  reverse?: boolean;
  fold?: boolean;
  ignoreBlanks?: boolean;
}

/** Map a per-key flag letter to a {@link SortKind}, if it selects one. */
function kindOfFlags(flags: string): SortKind | undefined {
  if (flags.includes('n')) return 'numeric';
  if (flags.includes('h')) return 'human';
  if (flags.includes('g')) return 'general';
  if (flags.includes('V')) return 'version';
  if (flags.includes('M')) return 'month';
  return undefined;
}

/** A `-k` key-spec validation failure carrying GNU's exact diagnostic (no `cmd:`). */
export class KeyError extends Error {}

/**
 * Parse a `-k` spec like `2`, `2.3`, `2,4`, `2,2n`, `2,2r`, `1.1,1.3`. Per-key
 * trailing flags (`n`/`h`/`g`/`V`/`M` ordering, `r` reverse, `f` fold case, `b`
 * ignore leading blanks) may appear on the start and/or end position. Rejects a
 * zero start field or an explicit zero START character offset with GNU's
 * diagnostic (throws {@link KeyError}); the caller reports exit 2.
 */
export function parseKey(spec: string): KeySpec {
  const [start, end] = spec.split(',');
  const parse = (s: string): { field: number; char: number; charGiven: boolean; flags: string } => {
    const m = /^([0-9]+)(?:\.([0-9]+))?([a-zA-Z]*)$/.exec(s);
    if (!m) return { field: 1, char: 0, charGiven: false, flags: '' };
    return { field: Number(m[1]), char: m[2] ? Number(m[2]) : 0, charGiven: m[2] !== undefined, flags: m[3] ?? '' };
  };
  const s = parse(start);
  // GNU: a zero field number, or an explicit `.0` START character offset, is a
  // hard error (exit 2). The quoted spec is the ORIGINAL, unmodified key text.
  if (s.field === 0) throw new KeyError(`field number is zero: invalid field specification ‘${spec}’`);
  if (s.charGiven && s.char === 0) throw new KeyError(`character offset is zero: invalid field specification ‘${spec}’`);
  const flags = s.flags + (end !== undefined ? parse(end).flags : '');
  const result: KeySpec = {
    startField: s.field,
    startChar: s.char > 0 ? s.char : 1,
  };
  if (end !== undefined) {
    const e = parse(end);
    if (e.field === 0) throw new KeyError(`field number is zero: invalid field specification ‘${spec}’`);
    result.endField = e.field;
    // End char 0 (no `.C`) means "through the end of the end field".
    if (e.char > 0) result.endChar = e.char;
  }
  const kind = kindOfFlags(flags);
  if (kind !== undefined) result.kind = kind;
  if (flags.includes('r')) result.reverse = true;
  if (flags.includes('f')) result.fold = true;
  if (flags.includes('b')) result.ignoreBlanks = true;
  return result;
}

/** Short options that take a value (so a following token is their argument, not a
 * cluster continuation): `-t SEP`, `-o FILE`, `-k SPEC`. */
const SORT_VALUE_OPTS = new Set(['t', 'o', 'k']);

/** Collect every `-k VALUE` / `-kVALUE` / `--key=VALUE` / `--key VALUE` from
 * argv, in order, so multiple keys are all honored. A clustered trailing `-k`
 * (e.g. `-nk 2`, `-rk2`) is also recognized: `k` inside a short-option cluster
 * consumes the rest of the cluster as a glued spec, or else the next token. */
function collectKeys(argv: string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (a === '-k' || a === '--key') { if (argv[i + 1] !== undefined) keys.push(argv[++i]); continue; }
    if (a.startsWith('--key=')) { keys.push(a.slice('--key='.length)); continue; }
    if (a.startsWith('--') || !a.startsWith('-') || a.length < 2) continue;
    // A short-option cluster: walk each letter. A value-taking option consumes
    // the rest of the cluster (glued) or the next token, then ends the cluster.
    const cluster = a.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const ch = cluster[j];
      if (SORT_VALUE_OPTS.has(ch)) {
        const rest = cluster.slice(j + 1);
        const value = rest.length > 0 ? rest : (argv[i + 1] !== undefined ? argv[++i] : undefined);
        if (ch === 'k' && value !== undefined) keys.push(value);
        break;
      }
    }
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

/** The comparison ordering a key/the whole line uses (mutually exclusive in GNU). */
export type SortKind = 'lex' | 'numeric' | 'human' | 'general' | 'version' | 'month';

/** Parse a leading numeric value from `-h` input (base-1024 K/M/G/T/P/E suffix). */
function humanValue(s: string): number {
  const m = /^\s*([+-]?[0-9]*\.?[0-9]+)\s*([kKMGTPEZY]?)/.exec(s);
  if (!m) return 0;
  const base = parseFloat(m[1]);
  const suf = m[2].toUpperCase();
  const pow = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8 }[suf] ?? 0;
  return base * 1024 ** pow;
}

/**
 * Parse a leading general-numeric value (`-g`), recognizing `inf`/`infinity`
 * and `nan` (case-insensitive, optional sign) as C `strtold` does — JS
 * `parseFloat` does not. Returns NaN for a non-number.
 */
function generalRank(s: string): number {
  const t = s.trim();
  const m = /^([+-]?)(inf(?:inity)?|nan)/i.exec(t);
  if (m) {
    if (/nan/i.test(m[2])) return Number.NaN;
    return m[1] === '-' ? -Infinity : Infinity;
  }
  const v = parseFloat(t);
  return Number.isNaN(v) ? Number.NaN : v;
}

function compareGeneral(a: string, b: string): number {
  // GNU `-g` orders: NaN < -inf < finite (ascending) < +inf. parseFloat gives
  // ±Infinity for inf/-inf and NaN for non-numbers.
  const va = generalRank(a);
  const vb = generalRank(b);
  const na = Number.isNaN(va);
  const nb = Number.isNaN(vb);
  if (na && nb) return 0;
  if (na) return -1;
  if (nb) return 1;
  if (va < vb) return -1;
  if (va > vb) return 1;
  return 0;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** Month rank 1..12 for `-M`; 0 for unrecognized (sorts before January). */
function monthRank(s: string): number {
  const key = s.replace(/^\s+/, '').slice(0, 3).toUpperCase();
  const idx = MONTHS.indexOf(key);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * GNU `filevercmp`-style version comparison (`-V`). Splits each string into
 * maximal digit / non-digit runs; non-digit runs compare with `~` before all,
 * then lexicographically; digit runs compare numerically with a leading-zero
 * tie-break (more leading zeros = smaller). Faithful to `strverscmp` for the
 * common package/version strings sort -V is used on.
 */
export function versionCompare(a: string, b: string): number {
  let i = 0, j = 0;
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';
  const orderChar = (c: string | undefined): number => {
    if (c === undefined) return 0;
    if (c === '~') return -1;
    if (isDigit(c)) return 0;
    if (/[a-zA-Z]/.test(c)) return c.charCodeAt(0);
    return c.charCodeAt(0) + 256; // non-alnum after letters
  };
  while (i < a.length || j < b.length) {
    // Compare a non-digit run char-by-char with the special ordering.
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const ca = i < a.length && !isDigit(a[i]) ? a[i] : undefined;
      const cb = j < b.length && !isDigit(b[j]) ? b[j] : undefined;
      const d = orderChar(ca) - orderChar(cb);
      if (d !== 0) return d < 0 ? -1 : 1;
      if (ca !== undefined) i++;
      if (cb !== undefined) j++;
    }
    // Now compare digit runs numerically (skip leading zeros; longer = larger).
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    let diff = 0;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (diff === 0) diff = a.charCodeAt(i) - b.charCodeAt(j);
      i++; j++;
    }
    if (isDigit(a[i])) return 1;   // a's number is longer → larger
    if (isDigit(b[j])) return -1;
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function compareValues(a: string, b: string, kind: SortKind, fold: boolean): number {
  switch (kind) {
    case 'numeric': {
      const na = parseFloat(a); const nb = parseFloat(b);
      const va = Number.isNaN(na) ? 0 : na;
      const vb = Number.isNaN(nb) ? 0 : nb;
      return va < vb ? -1 : va > vb ? 1 : 0;
    }
    case 'human': {
      const va = humanValue(a); const vb = humanValue(b);
      return va < vb ? -1 : va > vb ? 1 : 0;
    }
    case 'general': return compareGeneral(a, b);
    case 'version': return versionCompare(a, b);
    case 'month': {
      const ra = monthRank(a); const rb = monthRank(b);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    }
    default: {
      let x = a; let y = b;
      if (fold) { x = x.toUpperCase(); y = y.toUpperCase(); }
      return x < y ? -1 : x > y ? 1 : 0;
    }
  }
}

/** Read a whole file as NUL/`\n`-delimited records (a trailing delimiter drops the empty tail). */
async function readFileRecords(io: CommandIO, path: string, zero: boolean): Promise<string[]> {
  const bytes = await readFileBytes(io, path);
  return splitRecords(new TextDecoder().decode(bytes), zero);
}
async function readFileBytes(io: CommandIO, path: string): Promise<Uint8Array> {
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk); total += chunk.byteLength;
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return buf;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}
function splitRecords(text: string, zero: boolean): string[] {
  const sep = zero ? '\0' : '\n';
  if (text === '') return [];
  const body = text.endsWith(sep) ? text.slice(0, -1) : text;
  return body.split(sep);
}

/**
 * Pre-extract `-o FILE` / `--output=FILE` from argv (parseArgs would otherwise
 * treat a separate value as a positional/leave it dangling) and return the
 * output path plus argv with those tokens removed.
 */
function extractOutput(argv: string[]): { output?: string; filtered: string[] } {
  let output: string | undefined;
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { filtered.push(...argv.slice(i)); break; }
    if (a === '-o' || a === '--output') { if (argv[i + 1] !== undefined) output = argv[++i]; continue; }
    if (a.startsWith('--output=')) { output = a.slice('--output='.length); continue; }
    if (a.startsWith('-o') && a.length > 2 && !a.startsWith('--')) { output = a.slice(2); continue; }
    filtered.push(a);
  }
  return { output, filtered };
}

const sortCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'sort';
  const { output, filtered } = extractOutput(io.args.slice(1));
  const parsed = parseArgs(filtered, {
    boolean: ['n', 'r', 'u', 'f', 'b', 'h', 'g', 'V', 'M', 'c', 'C', 'z', 's', 'd', 'i', 'm', 'R',
      'numeric-sort', 'human-numeric-sort', 'general-numeric-sort', 'version-sort', 'month-sort',
      'reverse', 'unique', 'ignore-case', 'ignore-leading-blanks', 'check', 'zero-terminated', 'stable',
      'dictionary-order', 'ignore-nonprinting', 'merge', 'random-sort'],
    // `-S/-T/--parallel/--compress-program/--batch-size` are output-neutral
    // resource knobs: declared as value-taking so their argument is consumed
    // (not misparsed as an input file), then ignored — the sorted result is the
    // same. GNU accepts them all; declaring them keeps them from hitting the
    // exit-2 unknown-option path.
    string: ['t', 'k', 'field-separator', 'key', 'S', 'T',
      'buffer-size', 'temporary-directory', 'parallel', 'compress-program', 'batch-size'],
    alias: {
      'numeric-sort': 'n', 'human-numeric-sort': 'h', 'general-numeric-sort': 'g',
      'version-sort': 'V', 'month-sort': 'M', reverse: 'r', unique: 'u',
      'ignore-case': 'f', 'ignore-leading-blanks': 'b', 'field-separator': 't', key: 'k',
      'zero-terminated': 'z', stable: 's',
      'dictionary-order': 'd', 'ignore-nonprinting': 'i', merge: 'm', 'random-sort': 'R',
      'buffer-size': 'S', 'temporary-directory': 'T',
    },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const reverse = Boolean(flags.r);
  const unique = Boolean(flags.u);
  const fold = Boolean(flags.f);
  const ignoreBlanks = Boolean(flags.b);
  const zero = Boolean(flags.z);
  // `-d` (dictionary-order): compare only blanks + alphanumerics. `-i`
  // (ignore-nonprinting): compare only printable ASCII (0x20–0x7e). Both are
  // compare-only transforms — the original line is emitted unchanged.
  const dictionary = Boolean(flags.d);
  const ignoreNonprinting = Boolean(flags.i);
  // `-R` (random-sort): GNU orders by a random-seeded hash of keys, so exact
  // order is not byte-comparable to GNU (like `shuf`). We produce a shuffle.
  const randomSort = Boolean(flags.R);
  // `-m`/`--merge`: order-preserving k-way merge of inputs ASSUMED already
  // sorted (no re-sort within a run).
  const merge = Boolean(flags.m);
  // `-s`/`--stable`: suppress GNU's whole-line last-resort tiebreak, so records
  // with equal keys keep their input order.
  const stable = Boolean(flags.s);
  const sep = flags.t !== undefined ? String(flags.t) : undefined;
  const checkQuiet = Boolean(flags.C); // -C: check only, no message
  const check = Boolean(flags.c) || checkQuiet;
  // Global ordering kind, from -n/-h/-g/-V/-M (GNU takes the last-wins; we accept
  // any single one — combining them is undefined and rare).
  const globalKind: SortKind =
    flags.n ? 'numeric' : flags.h ? 'human' : flags.g ? 'general' :
      flags.V ? 'version' : flags.M ? 'month' : 'lex';
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;

  try {
    // GNU rejects an unknown option with exit 2 (unlike most coreutils' exit 1).
    if (parsed.unknown.length) {
      await writeString(err, `${optionError(name, parsed.unknown[0])}\n`);
      return 2;
    }
    // GNU rejects an empty field separator (`-t ''`) with `empty tab`, exit 2.
    if (flags.t !== undefined && String(flags.t) === '') {
      await writeString(err, `${name}: empty tab\n`);
      return 2;
    }
    // GNU rejects `-d`/`-i` combined with a numeric ordering (`-n/-g/-M/-h`):
    // e.g. `sort -d -n` → "options '-dn' are incompatible", exit 2. (`-f` is OK.)
    if (dictionary || ignoreNonprinting) {
      const num = flags.n ? 'n' : flags.g ? 'g' : flags.M ? 'M' : flags.h ? 'h' : undefined;
      if (num !== undefined) {
        const first = dictionary ? 'd' : 'i';
        // GNU reports the incompatible pair in a FIXED precedence order, not the
        // order the flags were given (e.g. `-i -g` → `-gi`, `-i -h` → `-hi`).
        const ORDER = ['d', 'g', 'h', 'i', 'M', 'n'];
        const pair = [first, num].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)).join('');
        await writeString(err, `${name}: options '-${pair}' are incompatible\n`);
        return 2;
      }
    }
    // Collect ALL `-k`/`--key` specs (parseArgs only keeps the last), preserving
    // their order so they apply as primary, secondary, … sort keys. A zero field
    // or explicit `.0` start offset is a GNU error (exit 2).
    let keys: KeySpec[];
    try { keys = collectKeys(filtered).map(parseKey); }
    catch (e) {
      if (e instanceof KeyError) { await writeString(err, `${name}: ${e.message}\n`); return 2; }
      throw e;
    }
    const sources = positionals.length > 0 ? positionals : ['-'];
    let lines: string[] = [];
    // For `-m` each source stays its own already-sorted run to be k-way merged.
    const runs: string[][] = [];
    for (const src of sources) {
      if (src === '-') {
        const rec = splitRecords(new TextDecoder().decode(await readAll(io.stdin)), zero);
        lines = lines.concat(rec);
        runs.push(rec);
      } else {
        try {
          const rec = await readFileRecords(io, src, zero);
          lines = lines.concat(rec);
          runs.push(rec);
        } catch (e) {
          await writeString(err, `${name}: cannot read: ${src}: ${errnoText(e)}\n`);
          exitCode = 1;
        }
      }
    }

    // `-d`/`-i` compare-transforms: strip the ignored characters before
    // comparison (the original line is still what gets emitted). `-d` keeps only
    // blanks + alphanumerics; `-i` keeps only printable ASCII (0x20–0x7e).
    const compareTransform = (s: string): string => {
      let t = s;
      if (dictionary) t = t.replace(/[^0-9A-Za-z \t]/g, '');
      if (ignoreNonprinting) t = t.replace(/[^\x20-\x7e]/g, '');
      return t;
    };

    // Extract the text for one key, applying its per-key `b` (or the global one).
    const keyText = (line: string, key: KeySpec): string => {
      let k = extractKey(line, key, sep);
      if (key.ignoreBlanks || ignoreBlanks) k = k.replace(/^\s+/, '');
      return compareTransform(k);
    };

    const stripB = (s: string): string => compareTransform(ignoreBlanks ? s.replace(/^\s+/, '') : s);

    // Compare using ONLY the configured keys (no whole-line last resort). Used
    // for `-u` dedup and for the key portion of the full comparison.
    const compareKeys = (a: string, b: string): number => {
      for (const key of keys) {
        const kk: SortKind = key.kind ?? globalKind;
        const kf = fold || Boolean(key.fold);
        let c = compareValues(keyText(a, key), keyText(b, key), kk, kf);
        if (key.reverse) c = -c;
        if (c !== 0) return c;
      }
      return 0;
    };

    // Full ordering comparison (with GNU's whole-line last resort). `reverse`
    // applies to the whole comparison.
    const compareLines = (a: string, b: string): number => {
      if (keys.length === 0) {
        const c = compareValues(stripB(a), stripB(b), globalKind, fold);
        if (c !== 0) return reverse ? -c : c;
        // GNU applies a final whole-line byte comparison as the last resort
        // (unless `-s`/`--stable`), so equal-key non-identical lines (e.g. two
        // unknown months under `-M`) get a deterministic order. Plain lex sort
        // already compares whole lines above; but with a compare-transform
        // (`-d`/`-i`/`-f`) the transformed keys tied — fall back to the RAW
        // untransformed lines, matching GNU.
        const hasTransform = dictionary || ignoreNonprinting || fold;
        // `-u` disables the whole-line last-resort so equal-key records keep
        // stable input order (GNU: the retained record is the FIRST input one).
        if ((globalKind === 'lex' && !hasTransform) || stable || unique) return 0;
        const w = compareValues(a, b, 'lex', false);
        return reverse ? -w : w;
      }
      const ck = compareKeys(a, b);
      if (ck !== 0) return reverse ? -ck : ck;
      // GNU last-resort: whole-line comparison (lexicographic) — suppressed by
      // `-s`/`--stable` and by `-u`, both of which keep equal-key records in
      // input order (under `-u` the first input record is the one retained).
      if (stable || unique) return 0;
      const c = compareValues(a, b, 'lex', false);
      return reverse ? -c : c;
    };

    // Equality for `-u`: with keys, only the keys decide; without, the
    // TRANSFORMED whole-line keys decide. We must NOT route through
    // compareLines here: its raw-byte last-resort tiebreak (line ~476) exists
    // only to give a deterministic ORDER among equal-key records and returns
    // nonzero for transform-tied-but-byte-different lines (e.g. `-f` on
    // Apple/apple), which would wrongly defeat dedup.
    const equalForUnique = (a: string, b: string): boolean =>
      keys.length === 0
        ? compareValues(stripB(a), stripB(b), globalKind, fold) === 0
        : compareKeys(a, b) === 0;

    const eol = zero ? '\0' : '\n';

    // `-c` / `-C`: verify the input is already sorted; do not reorder or output.
    if (check) {
      for (let i = 1; i < lines.length; i++) {
        const c = compareLines(lines[i - 1], lines[i]);
        const bad = unique ? c >= 0 : c > 0; // -u makes an equal adjacent pair a disorder too
        if (bad) {
          if (!checkQuiet) {
            const file = sources.length === 1 && sources[0] !== '-' ? sources[0] : '-';
            await writeString(err, `${name}: ${file}:${i + 1}: disorder: ${lines[i]}\n`);
          }
          return 1;
        }
      }
      return exitCode;
    }

    let result: string[];
    if (merge) {
      // Order-preserving k-way merge: inputs are ASSUMED already sorted, so we
      // never re-sort within a run. Repeatedly emit the smallest current head
      // (per the full comparator); ties keep input-run order (stable).
      const pos = runs.map(() => 0);
      result = [];
      for (;;) {
        let best = -1;
        for (let r = 0; r < runs.length; r++) {
          if (pos[r] >= runs[r].length) continue;
          if (best === -1 || compareLines(runs[r][pos[r]], runs[best][pos[best]]) < 0) best = r;
        }
        if (best === -1) break;
        result.push(runs[best][pos[best]++]);
      }
    } else if (randomSort) {
      // GNU `-R` hashes keys with a random seed → order is not byte-comparable to
      // GNU. Emulate with a Fisher–Yates shuffle (equal-key grouping skipped).
      result = lines.slice();
      for (let k = result.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [result[k], result[j]] = [result[j], result[k]];
      }
    } else {
      const decorated = lines.map((line, idx) => ({ line, idx }));
      decorated.sort((a, b) => {
        const c = compareLines(a.line, b.line);
        if (c !== 0) return c;
        return a.idx - b.idx; // stable
      });
      result = decorated.map((d) => d.line);
    }
    if (unique) {
      const seen: string[] = [];
      let prev: string | undefined;
      for (const line of result) {
        if (prev === undefined || !equalForUnique(prev, line)) seen.push(line);
        prev = line;
      }
      result = seen;
    }

    const text = result.length > 0 ? result.join(eol) + eol : '';
    if (output !== undefined) {
      await writeFileText(io, output, text);
    } else if (text !== '') {
      await writeString(out, text);
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Write text to a VFS path (truncate/create) for `-o`. */
async function writeFileText(io: CommandIO, path: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const { fd } = (await io.syscall('fs/open', {
    path, oflags: { write: true, create: true, truncate: true },
  })) as { fd: number };
  try {
    let off = 0;
    while (off < bytes.byteLength) {
      const slice = bytes.subarray(off, off + 65536);
      const { written } = (await io.syscall('fs/write', { fd, data: slice })) as { written: number };
      if (written <= 0) break;
      off += written;
    }
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

export default defineCommand(sortCommand);
export { sortCommand };

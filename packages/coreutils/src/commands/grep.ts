/**
 * `grep` (and `egrep` = `grep -E`, `fgrep` = `grep -F`) — print lines matching
 * a pattern.
 *
 * Flags (GNU parity subset):
 *   -i ignore-case, -v invert, -n line-numbers, -c count-only,
 *   -l files-with-matches, -L files-without-matches, -o only-matching,
 *   -w word-match, -x whole-line match, -E ERE, -F fixed-strings,
 *   -r/-R recursive over VFS directories, -e PAT (repeatable), -f FILE (patterns
 *   from file), -A N / -B N / -C N context, --color (default off — accepted but
 *   we only honor `--color=always` to emit SGR around matches),
 *   -q/--quiet/--silent (no output; exit on first match), -m N/--max-count N
 *   (stop after N matches per file), --include=GLOB / --exclude=GLOB (filter
 *   files by basename during -r recursion).
 *
 * Exit status: 0 if any line matched, 1 if none, 2 on error (bad pattern,
 * unreadable -f file, missing pattern).
 *
 * Default syntax is BRE; `-E` selects ERE; `-F` fixed strings. See `_regex.ts`
 * for the honest BRE↔ERE translation story (we translate the common BRE
 * metacharacter-escaping rules and otherwise defer to the JS RegExp engine).
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, readAllText, streamLines, writeBytes, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { breToEre, escapeRegExp, translatePosixClasses } from './_regex.ts';
import type { RegexSyntax } from './_regex.ts';

interface GrepOptions {
  ignoreCase: boolean;
  invert: boolean;
  lineNumber: boolean;
  count: boolean;
  listMatches: boolean; // -l
  listNoMatches: boolean; // -L
  onlyMatching: boolean; // -o
  word: boolean; // -w
  line: boolean; // -x
  recursive: boolean;
  syntax: RegexSyntax;
  perl: boolean; // -P: PCRE (map the pattern straight to a JS RegExp)
  after: number;
  before: number;
  color: boolean;
  quiet: boolean; // -q: suppress output, exit 0 on first match
  maxCount: number; // -m N: stop after N matches per file (0 = unlimited)
  withFilename: boolean; // -H: always prefix output with the filename
  noFilename: boolean; // -h: never prefix output with the filename
  byteOffset: boolean; // -b: prefix each output line with its 0-based byte offset
  nulData: boolean; // -z: input/output records are NUL-separated (lines may span \n)
  include: RegExp[]; // --include=GLOB filters (-r): keep only matching basenames
  exclude: RegExp[]; // --exclude=GLOB filters (-r): drop matching basenames
  patterns: string[];
  patternFiles: string[];
  files: string[];
}

/** Compile a filename glob (`*`/`?`/`[..]`) into an anchored, per-component RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (glob[j] === '!') { cls += '^'; j++; }
      while (j < glob.length && glob[j] !== ']') { cls += glob[j]; j++; }
      cls += ']';
      re += cls;
      i = j;
    } else if ('.+^${}()|\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

/** The basename of a path (after the last `/`). */
function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

// GNU grep's default GREP_COLORS: matches are `01;31` (bold red), filenames `35`
// (magenta), line numbers / byte offsets `32` (green), separators `36` (cyan).
// Each SGR is followed by `\e[K` (erase to end of line) and the reset is the bare
// `\e[m` — byte-exact with GNU's output.
const CL_ERASE = '\x1b[K';
const CL_RESET = '\x1b[m' + CL_ERASE;
const CL_MATCH = '\x1b[01;31m' + CL_ERASE;
const CL_FILE = '\x1b[35m' + CL_ERASE;
const CL_LINENO = '\x1b[32m' + CL_ERASE;
const CL_SEP = '\x1b[36m' + CL_ERASE;
const RED = CL_MATCH;
const RESET = CL_RESET;

/** Wrap a filename prefix in the filename color, GNU-style. */
function colFile(s: string): string { return CL_FILE + s + CL_RESET; }
/** Wrap the line-number / byte-offset field in the "line" color, GNU-style. */
function colLineno(s: string): string { return CL_LINENO + s + CL_RESET; }
/** Wrap a field separator (`:`/`-`) in the separator color, GNU-style. */
function colSep(s: string): string { return CL_SEP + s + CL_RESET; }

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
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(out);
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/**
 * Recursively collect regular-file paths under `path`, sorted, mirroring grep
 * -r. When `include`/`exclude` globs are set they filter regular files by
 * basename (a file is kept only if it matches some `include`, when any are
 * given, and matches no `exclude`). Directories are always descended.
 */
async function collectFilesRecursive(
  io: CommandIO, path: string, out: string[], include: RegExp[], exclude: RegExp[],
): Promise<void> {
  let stat: { type?: string };
  try {
    stat = (await io.syscall('fs/stat', { dirfd: -100, path })) as { type?: string };
  } catch {
    return;
  }
  if (stat.type === 'directory') {
    let entries: { name: string }[];
    try {
      entries = (await io.syscall('fs/readdir', { dirfd: -100, path })) as { name: string }[];
    } catch {
      return;
    }
    const names = entries.map((e) => e.name).sort();
    const base = path.endsWith('/') ? path.slice(0, -1) : path;
    for (const name of names) {
      await collectFilesRecursive(io, `${base}/${name}`, out, include, exclude);
    }
  } else if (stat.type === 'file' || stat.type === undefined) {
    const bn = baseName(path);
    if (include.length > 0 && !include.some((re) => re.test(bn))) return;
    if (exclude.some((re) => re.test(bn))) return;
    out.push(path);
  }
}

/** Manual getopt-style parse: -e/-f are repeatable, -A/-B/-C take a number. */
function parseGrepArgs(argv: string[]): GrepOptions {
  const o: GrepOptions = {
    ignoreCase: false, invert: false, lineNumber: false, count: false,
    listMatches: false, listNoMatches: false, onlyMatching: false,
    word: false, line: false, recursive: false, syntax: 'bre', perl: false,
    after: 0, before: 0, color: false,
    quiet: false, maxCount: 0,
    withFilename: false, noFilename: false, byteOffset: false, nulData: false,
    include: [], exclude: [],
    patterns: [], patternFiles: [], files: [],
  };
  let patternSeen = false;
  let i = 0;
  const num = (s: string | undefined): number => {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      i++;
      while (i < argv.length) { pushOperand(o, argv[i], () => patternSeen, (v) => { patternSeen = v; }); i++; }
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const val = eq >= 0 ? arg.slice(eq + 1) : undefined;
      switch (name) {
        case 'ignore-case': o.ignoreCase = true; break;
        case 'invert-match': o.invert = true; break;
        case 'line-number': o.lineNumber = true; break;
        case 'count': o.count = true; break;
        case 'files-with-matches': o.listMatches = true; break;
        case 'files-without-match': o.listNoMatches = true; break;
        case 'only-matching': o.onlyMatching = true; break;
        case 'word-regexp': o.word = true; break;
        case 'line-regexp': o.line = true; break;
        case 'recursive': o.recursive = true; break;
        case 'extended-regexp': o.syntax = 'ere'; break;
        case 'fixed-strings': o.syntax = 'fixed'; break;
        case 'perl-regexp': o.perl = true; break;
        case 'with-filename': o.withFilename = true; break;
        case 'no-filename': o.noFilename = true; break;
        case 'byte-offset': o.byteOffset = true; break;
        case 'null-data': o.nulData = true; break;
        case 'regexp': if (val !== undefined) { o.patterns.push(val); patternSeen = true; } else { o.patterns.push(argv[++i] ?? ''); patternSeen = true; } break;
        case 'file': if (val !== undefined) o.patternFiles.push(val); else o.patternFiles.push(argv[++i] ?? ''); patternSeen = true; break;
        case 'after-context': o.after = num(val ?? argv[++i]); break;
        case 'before-context': o.before = num(val ?? argv[++i]); break;
        case 'context': { const n = num(val ?? argv[++i]); o.after = n; o.before = n; break; }
        case 'color': case 'colour': o.color = val === 'always' || val === 'auto'; break;
        case 'quiet': case 'silent': o.quiet = true; break;
        case 'max-count': o.maxCount = num(val ?? argv[++i]); break;
        case 'include': o.include.push(globToRegExp(val ?? argv[++i] ?? '')); break;
        case 'exclude': o.exclude.push(globToRegExp(val ?? argv[++i] ?? '')); break;
        default: break;
      }
      i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const cluster = arg.slice(1);
      let consumedNext = false;
      for (let j = 0; j < cluster.length; j++) {
        const ch = cluster[j];
        switch (ch) {
          case 'i': o.ignoreCase = true; break;
          case 'v': o.invert = true; break;
          case 'n': o.lineNumber = true; break;
          case 'c': o.count = true; break;
          case 'l': o.listMatches = true; break;
          case 'L': o.listNoMatches = true; break;
          case 'o': o.onlyMatching = true; break;
          case 'w': o.word = true; break;
          case 'x': o.line = true; break;
          case 'r': case 'R': o.recursive = true; break;
          case 'q': o.quiet = true; break;
          case 'E': o.syntax = 'ere'; break;
          case 'F': o.syntax = 'fixed'; break;
          case 'P': o.perl = true; break;
          case 'H': o.withFilename = true; break;
          case 'h': o.noFilename = true; break;
          case 'b': o.byteOffset = true; break;
          case 'z': o.nulData = true; break;
          case 'm': {
            const rest = cluster.slice(j + 1);
            o.maxCount = rest.length > 0 ? num(rest) : (consumedNext = true, num(argv[++i]));
            j = cluster.length;
            break;
          }
          case 'e': {
            const rest = cluster.slice(j + 1);
            if (rest.length > 0) { o.patterns.push(rest); } else { o.patterns.push(argv[++i] ?? ''); consumedNext = true; }
            patternSeen = true;
            j = cluster.length;
            break;
          }
          case 'f': {
            const rest = cluster.slice(j + 1);
            if (rest.length > 0) { o.patternFiles.push(rest); } else { o.patternFiles.push(argv[++i] ?? ''); consumedNext = true; }
            patternSeen = true;
            j = cluster.length;
            break;
          }
          case 'A': case 'B': case 'C': {
            const rest = cluster.slice(j + 1);
            const n = rest.length > 0 ? num(rest) : (consumedNext = true, num(argv[++i]));
            if (ch === 'A') o.after = n;
            else if (ch === 'B') o.before = n;
            else { o.after = n; o.before = n; }
            j = cluster.length;
            break;
          }
          default: break;
        }
      }
      void consumedNext;
      i++;
      continue;
    }
    pushOperand(o, arg, () => patternSeen, (v) => { patternSeen = v; });
    i++;
  }
  return o;
}

function pushOperand(o: GrepOptions, arg: string, seen: () => boolean, setSeen: (v: boolean) => void): void {
  // First non-flag operand is the pattern (unless -e/-f already supplied one).
  if (!seen() && o.patterns.length === 0 && o.patternFiles.length === 0) {
    o.patterns.push(arg);
    setSeen(true);
  } else {
    o.files.push(arg);
  }
}

interface CompiledMatcher {
  /** Does the (whole) line match, before applying -v? */
  rawMatch(line: string): boolean;
  /** All match spans in the line (for -o / --color). */
  spans(line: string): { start: number; end: number }[];
}

/**
 * Translate the GNU word-boundary operators `\<` (start of word) and `\>` (end
 * of word) into the JS `\b` word boundary. GNU accepts these in both BRE and
 * ERE; JS RegExp has no `\<`/`\>` so we map both to `\b`. We skip the transform
 * inside bracket expressions (where they are literal) and leave every other
 * escape untouched.
 */
function translateWordAnchors(pattern: string): string {
  let out = '';
  let i = 0;
  let inClass = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (inClass) {
      out += c;
      if (c === ']') inClass = false;
      i++;
      continue;
    }
    if (c === '[') { inClass = true; out += c; i++; continue; }
    if (c === '\\' && (pattern[i + 1] === '<' || pattern[i + 1] === '>')) {
      out += '\\b';
      i += 2;
      continue;
    }
    if (c === '\\' && i + 1 < pattern.length) { out += c + pattern[i + 1]; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

/**
 * Neutralize an orphan quantifier at the start of a (translated) regex source so
 * the JS engine does not throw "Nothing to repeat", matching GNU grep (which
 * only warns). The two grammars differ:
 *   - BRE: a leading `*` is a LITERAL `*` (GNU) → escape it. `+ ? ` are already
 *     literal in BRE (they were escaped by breToEre), so only `*` appears here.
 *   - ERE: a leading `* + ?` is a NO-OP → drop it (so `*x` behaves as `x`);
 *     repeat to collapse runs like `**x`.
 * Applies at the very start of the source and immediately after an opening group
 * `(` or an alternation `|` (both positions have nothing to repeat).
 */
function fixOrphanQuantifiers(source: string, ere: boolean): string {
  if (ere) {
    let prev: string;
    let cur = source;
    do { prev = cur; cur = prev.replace(/(^|[(|])[*+?]/g, (_m, pre: string) => pre); } while (cur !== prev);
    return cur;
  }
  return source.replace(/(^|[(|])(\*)/g, (_m, pre: string, q: string) => pre + '\\' + q);
}

function buildMatcher(o: GrepOptions): CompiledMatcher {
  const flags = (o.ignoreCase ? 'i' : '');
  // Wrap each pattern source per -w / -x semantics, then OR them in one RegExp.
  const wrap = (raw: string): string => {
    let body: string;
    if (o.perl) {
      // -P: PCRE — pass the pattern straight through to the JS RegExp engine
      // (a close superset for the common lookaround / class / anchor cases).
      body = raw === '' ? '(?:)' : raw;
    } else if (o.syntax === 'fixed') {
      body = escapeRegExp(raw);
    } else {
      // Build the ERE/JS source WITHOUT compiling yet (compiling here would
      // throw on a leading orphan `*`), then translate `\<`/`\>` word anchors
      // and neutralize an orphan quantifier (literal in GNU) before the union
      // is compiled once below.
      const ere = o.syntax === 'ere';
      const translated = translatePosixClasses(raw);
      const src = ere ? translated : breToEre(translated);
      const fixed = fixOrphanQuantifiers(translateWordAnchors(src), ere);
      body = fixed === '' ? '(?:)' : fixed;
    }
    return `(?:${body})`;
  };
  const sources = o.patterns.map(wrap);
  const union = sources.length === 1 ? sources[0] : sources.join('|');
  let finalSource = union === '' ? '(?:)' : union;
  if (o.line) finalSource = `^(?:${finalSource})$`;
  else if (o.word) finalSource = `(?<![A-Za-z0-9_])(?:${finalSource})(?![A-Za-z0-9_])`;
  const re = new RegExp(finalSource, flags);
  const reG = new RegExp(finalSource, flags + 'g');
  return {
    rawMatch: (line) => { re.lastIndex = 0; return re.test(line); },
    spans: (line) => {
      const out: { start: number; end: number }[] = [];
      reG.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = reG.exec(line)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) reG.lastIndex++;
      }
      return out;
    },
  };
}

interface MatchResult {
  /** Lines emitted (already formatted with prefixes, no trailing newline). */
  output: string[];
  matched: boolean;
  matchCount: number;
}

function colorize(line: string, spans: { start: number; end: number }[]): string {
  if (spans.length === 0) return line;
  let out = '';
  let pos = 0;
  for (const s of spans) {
    // GNU grep only highlights matches of length > 0 — a zero-length match (from
    // `o*`, `^`, `$`, etc.) is not wrapped in SGR codes (mirrors the -o guards).
    if (s.end === s.start) continue;
    out += line.slice(pos, s.start) + RED + line.slice(s.start, s.end) + RESET;
    pos = s.end;
  }
  out += line.slice(pos);
  return out;
}

const TEXT_ENC = new TextEncoder();
/** UTF-8 byte length of a string (for `-b` offsets over non-ASCII input). */
function byteLen(s: string): number { return TEXT_ENC.encode(s).length; }

/**
 * Build the leading prefix fields (`filename`, `-b` byte offset, `-n` line
 * number) joined and terminated by `sep` (`:` for a match line, `-` for a
 * context line). Colors each field per GNU's GREP_COLORS when `o.color`. The
 * `prefix` is the filename to show (undefined = none). `byteOff` is the field's
 * byte offset; omit (undefined) to skip `-b`.
 */
function buildPrefix(o: GrepOptions, prefix: string | undefined, byteOff: number | undefined, lineno: number, sep: ':' | '-'): string {
  let s = '';
  const sepStr = o.color ? colSep(sep) : sep;
  if (prefix !== undefined) s += (o.color ? colFile(prefix) : prefix) + sepStr;
  if (o.byteOffset && byteOff !== undefined) s += (o.color ? colLineno(String(byteOff)) : String(byteOff)) + sepStr;
  if (o.lineNumber) s += (o.color ? colLineno(String(lineno)) : String(lineno)) + sepStr;
  return s;
}

/** Run the matcher over one file's lines, producing formatted output lines. */
function grepLines(
  lines: string[],
  matcher: CompiledMatcher,
  o: GrepOptions,
  prefix: string | undefined,
  lineByteOffset?: number[],
): MatchResult {
  const matchedIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = matcher.rawMatch(lines[i]);
    if (o.invert ? !m : m) matchedIdx.push(i);
    if (o.maxCount > 0 && matchedIdx.length >= o.maxCount) break; // -m N: stop after N
  }
  const matched = matchedIdx.length > 0;

  if (o.count) {
    // `-c` never colors and never carries a byte offset.
    const text = prefix !== undefined ? `${prefix}:${matchedIdx.length}` : `${matchedIdx.length}`;
    return { output: [text], matched, matchCount: matchedIdx.length };
  }

  const fmt = (line: string, idx: number, sep: ':' | '-'): string => {
    let body = line;
    if (o.color && sep === ':' && !o.invert) body = colorize(line, matcher.spans(line));
    const bo = lineByteOffset ? lineByteOffset[idx] : undefined;
    return buildPrefix(o, prefix, bo, idx + 1, sep) + body;
  };

  const output: string[] = [];

  if (o.onlyMatching && !o.invert) {
    for (const idx of matchedIdx) {
      const lineBo = lineByteOffset ? lineByteOffset[idx] : undefined;
      for (const span of matcher.spans(lines[idx])) {
        // `-o` suppresses empty matches entirely (no spurious blank lines).
        if (span.end === span.start) continue;
        let piece = lines[idx].slice(span.start, span.end);
        if (o.color) piece = RED + piece + RESET;
        // `-b` with `-o` reports the byte offset of the MATCH, not the line.
        const bo = lineBo !== undefined ? lineBo + byteLen(lines[idx].slice(0, span.start)) : undefined;
        output.push(buildPrefix(o, prefix, bo, idx + 1, ':') + piece);
      }
    }
    return { output, matched, matchCount: matchedIdx.length };
  }

  if (o.after === 0 && o.before === 0) {
    for (const idx of matchedIdx) output.push(fmt(lines[idx], idx, ':'));
    return { output, matched, matchCount: matchedIdx.length };
  }

  // Context mode: emit before/after windows with `--` separators on gaps.
  let lastPrinted = -1;
  const matchSet = new Set(matchedIdx);
  for (const idx of matchedIdx) {
    const start = Math.max(0, idx - o.before);
    const end = Math.min(lines.length - 1, idx + o.after);
    if (lastPrinted >= 0 && start > lastPrinted + 1) output.push('--');
    const from = lastPrinted >= 0 && start <= lastPrinted + 1 ? lastPrinted + 1 : start;
    for (let k = from; k <= end; k++) {
      output.push(fmt(lines[k], k, matchSet.has(k) ? ':' : '-'));
    }
    if (end > lastPrinted) lastPrinted = end;
  }
  return { output, matched, matchCount: matchedIdx.length };
}

/** Split text into lines for grep: drop a single trailing empty line. */
function toLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Split `text` into records for `-z` (NUL-separated) mode: records are delimited
 * by `\0`; a trailing empty record after the last `\0` is dropped. Newlines are
 * ordinary characters within a record.
 */
function toRecords(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Byte offset of the start of each line (parallel to {@link toLines}). Each
 * line contributes its own byte length plus one for the `\n` (or `\0` in `-z`). */
function lineByteOffsets(lines: string[]): number[] {
  const offs: number[] = [];
  let acc = 0;
  for (const l of lines) { offs.push(acc); acc += byteLen(l) + 1; }
  return offs;
}

/**
 * Format ONE matching line (1-based `lineno`) for the simple mode (no context,
 * no count, no list). Returns the output text WITH a trailing terminator, or ''
 * if the line is not selected. `-o` may emit multiple output lines for one input
 * line. This is the streaming-path equivalent of {@link grepLines}.
 */
function formatLine(line: string, lineno: number, matcher: CompiledMatcher, o: GrepOptions, prefix: string | undefined, byteOff: number | undefined, term: string): string {
  const m = matcher.rawMatch(line);
  const selected = o.invert ? !m : m;
  if (!selected) return '';

  if (o.onlyMatching && !o.invert) {
    let out = '';
    for (const span of matcher.spans(line)) {
      if (span.end === span.start) continue; // `-o`: no empty-match blank lines
      let piece = line.slice(span.start, span.end);
      if (o.color) piece = RED + piece + RESET;
      const bo = byteOff !== undefined ? byteOff + byteLen(line.slice(0, span.start)) : undefined;
      out += buildPrefix(o, prefix, bo, lineno, ':') + piece + term;
    }
    return out;
  }

  let body = line;
  if (o.color && !o.invert) body = colorize(line, matcher.spans(line));
  return buildPrefix(o, prefix, byteOff, lineno, ':') + body + term;
}

const grepCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'grep';
  const o = parseGrepArgs(io.args.slice(1));

  // egrep / fgrep aliases.
  if (name === 'egrep') o.syntax = 'ere';
  if (name === 'fgrep') o.syntax = 'fixed';

  const err = io.stderr.getWriter();
  const out = io.stdout.getWriter();
  const enc = new TextEncoder();
  try {
    // Gather patterns from -f files.
    for (const pf of o.patternFiles) {
      let text: string;
      try {
        text = await readFileText(io, pf);
      } catch {
        await writeLine(err, `${name}: ${pf}: No such file or directory`);
        return 2;
      }
      for (const line of toLines(text)) o.patterns.push(line);
    }

    if (o.patterns.length === 0) {
      await writeLine(err, `Usage: ${name} [OPTION]... PATTERN [FILE]...`);
      return 2;
    }

    let matcher: CompiledMatcher;
    try {
      matcher = buildMatcher(o);
    } catch (e) {
      await writeLine(err, `${name}: ${(e as Error).message}`);
      return 2;
    }

    // Resolve file list (recursive expansion).
    if (o.recursive && o.files.length === 0) o.files.push('.');
    let files = o.files;
    if (o.recursive) {
      const expanded: string[] = [];
      for (const f of o.files) await collectFilesRecursive(io, f, expanded, o.include, o.exclude);
      files = expanded;
    }

    const multiFile = files.length > 1;
    // GNU: `-H` forces the filename prefix, `-h` suppresses it; otherwise the
    // filename is shown when there is more than one file or under `-r`.
    const showFilename = o.withFilename || (!o.noFilename && (multiFile || o.recursive));
    // Record splitter + output terminator honor `-z` (NUL-separated data).
    const splitRecords = o.nulData ? toRecords : toLines;
    const term = o.nulData ? '\0' : '\n';
    // `-c` always terminates its count line with a newline, even under `-z`.
    const outTerm = o.count ? '\n' : term;
    let anyMatch = false;
    let hadError = false;

    // -l / -L: list filenames only.
    if (o.listMatches || o.listNoMatches) {
      const sources = files.length > 0 ? files : ['-'];
      for (const f of sources) {
        let text: string;
        try {
          text = f === '-' ? await readAllText(io.stdin) : await readFileText(io, f);
        } catch {
          await writeLine(err, `${name}: ${f}: No such file or directory`);
          hadError = true;
          continue;
        }
        const lines = splitRecords(text);
        const fileMatched = lines.some((l) => (o.invert ? !matcher.rawMatch(l) : matcher.rawMatch(l)));
        const label = f === '-' ? '(standard input)' : f;
        if (o.listMatches && fileMatched) { await writeLine(out, label); anyMatch = true; }
        if (o.listNoMatches && !fileMatched) { await writeLine(out, label); }
        if (fileMatched) anyMatch = true;
      }
      if (hadError) return 2;
      return anyMatch ? 0 : 1;
    }

    // -q / --quiet / --silent: no output; exit 0 on the FIRST match (and stop
    // reading), exit 1 if nothing matches, exit 2 on a read error WITHOUT a
    // match. GNU precedence: a match (0) wins over a read error. Overrides all
    // output modes.
    if (o.quiet) {
      const test = (l: string): boolean => (o.invert ? !matcher.rawMatch(l) : matcher.rawMatch(l));
      if (files.length === 0) {
        try {
          for await (const { line } of streamLines(io.stdin)) {
            if (test(line)) { await io.stdin.cancel().catch(() => {}); return 0; }
          }
        } catch (e) {
          if (!isBrokenPipe(e)) throw e;
        }
        return 1;
      }
      for (const f of files) {
        let text: string;
        try { text = await readFileText(io, f); }
        catch { hadError = true; continue; }
        // A match wins over any prior read error (GNU precedence: match → 0).
        if (splitRecords(text).some(test)) return 0;
      }
      // No match: a read error makes the exit 2 (GNU), else 1.
      return hadError ? 2 : 1;
    }

    // Normal / count / context modes.
    if (files.length === 0) {
      const stdinPrefix = showFilename ? '(standard input)' : undefined;
      // Stream stdin line-by-line for the simple mode (no count, no context, no
      // byte offsets, no NUL records) so `producer | grep x | head` terminates
      // in constant memory and stops on a broken downstream pipe. The other
      // modes need the whole input, so they buffer via readAllText.
      const simple = !o.count && o.after === 0 && o.before === 0 && !o.byteOffset && !o.nulData;
      if (simple) {
        const sink = new CoalescingWriter(out);
        let lineno = 0;
        let matched = false;
        let matchCount = 0;
        try {
          for await (const { line } of streamLines(io.stdin)) {
            lineno++;
            const rm = matcher.rawMatch(line);
            const selected = o.invert ? !rm : rm;
            if (!selected) continue;
            // A selected line counts as a match even when `-o` prints nothing
            // for it (e.g. `x*` matching only the empty string): exit stays 0.
            matched = true; matchCount++;
            const piece = formatLine(line, lineno, matcher, o, stdinPrefix, undefined, term);
            if (piece !== '') await sink.push(piece);
            // -m N: stop reading once N lines have matched.
            if (o.maxCount > 0 && matchCount >= o.maxCount) { await io.stdin.cancel().catch(() => {}); break; }
          }
          await sink.flush();
        } catch (e) {
          if (isBrokenPipe(e)) { await io.stdin.cancel().catch(() => {}); return matched ? 0 : 1; }
          throw e;
        }
        return matched ? 0 : 1;
      }
      const text = await readAllText(io.stdin);
      const recs = splitRecords(text);
      const offs = o.byteOffset ? lineByteOffsets(recs) : undefined;
      const res = grepLines(recs, matcher, o, stdinPrefix, offs);
      for (const line of res.output) await writeBytes(out, enc.encode(line + outTerm));
      return res.matched ? 0 : 1;
    }

    for (const f of files) {
      let text: string;
      try {
        text = await readFileText(io, f);
      } catch {
        await writeLine(err, `${name}: ${f}: No such file or directory`);
        hadError = true;
        continue;
      }
      const prefix = showFilename ? f : undefined;
      const recs = splitRecords(text);
      const offs = o.byteOffset ? lineByteOffsets(recs) : undefined;
      const res = grepLines(recs, matcher, o, prefix, offs);
      for (const line of res.output) await writeBytes(out, enc.encode(line + outTerm));
      if (res.matched) anyMatch = true;
    }

    if (hadError) return 2;
    return anyMatch ? 0 : 1;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(grepCommand);
export { grepCommand };

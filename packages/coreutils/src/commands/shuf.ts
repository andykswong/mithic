/**
 * `shuf` — generate random permutations of input lines.
 *
 * Randomness: `Math.random` is forbidden in the guest sandbox (it may be
 * stripped). Instead we use a seeded Mulberry32 PRNG — a fast, good-quality
 * 32-bit PRNG that needs only a single 32-bit seed. The seed is taken from:
 *   1. `--random-source` env var `SHUF_SEED` (integer string)
 *   2. `--random-source=N` flag (not a real file, treated as seed)
 *   3. Default seed 42 (deterministic but documented)
 *
 * Flags:
 *   -n N / --head-count=N   output at most N lines
 *   -e / --echo             treat each ARG as an input line (not stdin/FILE)
 *   -i LO-HI / --input-range=LO-HI  shuffle integers in LO..HI
 *   -r / --repeat           sample with replacement (repeats allowed); needs -n
 *   -o FILE / --output=FILE write result to FILE instead of stdout
 *   -z / --zero-terminated  NUL line delimiter
 *   FILE                    input file (default/`-` = stdin) unless -e/-i
 */
import { defineCommand, parseArgs, readAll, exitWith, fsErrorText } from '../harness.ts';
import { readFile, writeFile } from '../fs.ts';
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

/** Mulberry32: a fast seeded PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s |= 0; s = s + 0x6d2b79f5 | 0;
    let z = Math.imul(s ^ (s >>> 15), 1 | s);
    z ^= z + Math.imul(z ^ (z >>> 7), 61 | z);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle in place. */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Split bytes into records on `\n` (or `\0` when zero); trailing delimiter drops the empty tail. */
function splitRecords(bytes: Uint8Array, zero: boolean): string[] {
  const text = new TextDecoder().decode(bytes);
  const sep = zero ? '\0' : '\n';
  if (text === '') return [];
  const body = text.endsWith(sep) ? text.slice(0, -1) : text;
  return body.split(sep);
}

const shufCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'shuf';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['e', 'echo', 'r', 'repeat', 'z', 'zero-terminated'],
    string: ['n', 'head-count', 'i', 'input-range', 'o', 'output', 'random-source'],
    alias: { echo: 'e', 'head-count': 'n', 'input-range': 'i', 'zero-terminated': 'z', repeat: 'r', output: 'o' },
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    // GNU rejects a REPEATED -i/--input-range (parseArgs would silently last-win).
    let iCount = 0;
    const raw = io.args.slice(1);
    for (let k = 0; k < raw.length; k++) {
      const a = raw[k];
      if (a === '--') break;
      if (a === '-i' || a === '--input-range') { iCount++; if (raw[k + 1] !== undefined) k++; }
      else if (a.startsWith('--input-range=')) iCount++;
      else if (a.startsWith('-i') && !a.startsWith('--')) iCount++;
    }
    if (iCount > 1) {
      return await exitWith(err, 1, `${name}: multiple -i options specified`);
    }
    const echo = Boolean(flags.e);
    const repeat = Boolean(flags.r);
    const zero = Boolean(flags.z);
    const sep = zero ? '\0' : '\n';

    // -e and -i are mutually exclusive.
    if (echo && flags.i !== undefined) {
      return await exitWith(err, 1, `${name}: cannot combine -e and -i options\nTry '${name} --help' for more information.`);
    }

    // Resolve the head-count limit (may be absent).
    let limit = Infinity;
    if (flags.n !== undefined) {
      const raw = String(flags.n);
      const parsed = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (Number.isNaN(parsed)) return await exitWith(err, 1, `${name}: invalid line count: ‘${raw}’`);
      limit = parsed;
    }

    // Resolve the seed.
    const seedStr = flags['random-source'] !== undefined ? String(flags['random-source']) : (io.env['SHUF_SEED'] ?? '42');
    let seed = parseInt(seedStr, 10);
    if (isNaN(seed)) seed = 42;
    const rand = mulberry32(seed);

    // Assemble the candidate lines from the selected source.
    let lines: string[];
    if (echo) {
      // Every operand is an input line (any count allowed).
      lines = positionals.slice();
    } else if (flags.i !== undefined) {
      // -i LO-HI: extra operands are an error.
      if (positionals.length > 0) {
        return await exitWith(err, 1, `${name}: extra operand ‘${positionals[0]}’\nTry '${name} --help' for more information.`);
      }
      const m = /^(\d+)-(\d+)$/.exec(String(flags.i));
      if (!m) return await exitWith(err, 1, `${name}: invalid input range: ‘${flags.i}’`);
      const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
      if (lo > hi) return await exitWith(err, 1, `${name}: invalid input range: ‘${flags.i}’`);
      lines = [];
      for (let x = lo; x <= hi; x++) lines.push(String(x));
    } else {
      // A single FILE operand (or `-`/none = stdin); more than one is an error.
      if (positionals.length > 1) {
        return await exitWith(err, 1, `${name}: extra operand ‘${positionals[1]}’\nTry '${name} --help' for more information.`);
      }
      const input = positionals[0];
      if (input === undefined || input === '-') {
        lines = splitRecords(await readAll(io.stdin), zero);
      } else {
        try { lines = splitRecords(await readFile(io, input), zero); }
        catch (e) {
          return await exitWith(err, 1, `${name}: ${input}: ${errnoText(e)}`);
        }
      }
    }

    // Build the output records.
    let outLines: string[];
    if (repeat) {
      // Sample with replacement. A finite `-n` bounds it (GNU streams forever
      // without one — here we require -n so the sandboxed process terminates).
      // GNU errors "no lines to repeat" only when it must emit ≥1 line but the
      // input is empty; `-r -n 0` on empty input is a clean no-op.
      // No lines to draw from: GNU errors unless `-n 0` (a bounded zero-line
      // no-op). Without `-n`, `-r` is conceptually infinite, so an empty input
      // is always an error.
      if (lines.length === 0 && (limit === Infinity || limit > 0)) {
        return await exitWith(err, 1, `${name}: no lines to repeat`);
      }
      const count = limit === Infinity ? lines.length : limit;
      outLines = [];
      for (let i = 0; i < count; i++) outLines.push(lines[Math.floor(rand() * lines.length)]);
    } else {
      shuffle(lines, rand);
      const count = Math.min(limit, lines.length);
      outLines = lines.slice(0, count);
    }

    const text = outLines.length > 0 ? outLines.map((l) => l + sep).join('') : '';

    // Write to `-o FILE` or stdout.
    if (flags.o !== undefined) {
      await writeFile(io, String(flags.o), new TextEncoder().encode(text));
    } else if (text !== '') {
      await out.write(new TextEncoder().encode(text));
    }
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(shufCommand);
export { shufCommand };

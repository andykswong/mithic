/**
 * `shuf` — generate random permutations of input lines.
 *
 * Randomness: `Math.random` is forbidden in the guest sandbox (it may be
 * stripped). Instead we use a seeded Mulberry32 PRNG — a fast, good-quality
 * 32-bit PRNG that needs only a single 32-bit seed. The seed is taken from:
 *   1. `--random-source` env var `SHUF_SEED` (integer string)
 *   2. Positional arg `--random-source=N` (not a real file, treated as seed)
 *   3. Default seed 42 (deterministic but documented)
 *
 * Flags:
 *   -n N / --head-count=N   output at most N lines
 *   -e / --echo             treat each ARG as an input line (not stdin)
 *   -i LO-HI / --input-range=LO-HI  shuffle integers in LO..HI
 */
import { defineCommand, parseArgs, readLines, writeLine, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

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

const shufCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'shuf';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['e', 'echo', 'z', 'zero-terminated'],
    string: ['n', 'head-count', 'i', 'input-range', 'random-source'],
    alias: { echo: 'e', 'head-count': 'n', 'input-range': 'i', 'zero-terminated': 'z' },
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    // Resolve seed
    const seedStr = flags['random-source'] !== undefined ? String(flags['random-source']) : (io.env['SHUF_SEED'] ?? '42');
    let seed = parseInt(seedStr, 10);
    if (isNaN(seed)) seed = 42;
    const rand = mulberry32(seed);

    let lines: string[];

    if (flags.e) {
      // -e: treat positionals as lines
      lines = positionals.slice();
    } else if (flags.i) {
      // -i LO-HI: range
      const m = /^(\d+)-(\d+)$/.exec(String(flags.i));
      if (!m) return await exitWith(err, 1, `${name}: invalid input range: ${flags.i}`);
      const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
      if (lo > hi) return await exitWith(err, 1, `${name}: invalid input range`);
      lines = [];
      for (let x = lo; x <= hi; x++) lines.push(String(x));
    } else {
      // Read from stdin
      lines = await readLines(io.stdin);
    }

    shuffle(lines, rand);

    const limit = flags.n !== undefined ? parseInt(String(flags.n), 10) : lines.length;
    if (isNaN(limit) || limit < 0) return await exitWith(err, 1, `${name}: invalid count: ${flags.n}`);

    const count = Math.min(limit, lines.length);
    for (let i = 0; i < count; i++) {
      await writeLine(out, lines[i]);
    }
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(shufCommand);
export { shufCommand };

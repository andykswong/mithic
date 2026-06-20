/**
 * `mktemp` — create a unique temporary file (or directory) and print its path.
 *   -d / --directory : create a directory instead of a file
 *   -u / --dry-run   : do not create anything; just print a candidate name
 *   -q / --quiet     : suppress diagnostics
 *   -p DIR / --tmpdir[=DIR] : place the result under DIR (default $TMPDIR or /tmp)
 *   TEMPLATE         : a name whose trailing run of `X`es is replaced (>=3 Xs)
 *
 * RANDOMNESS WITHOUT Math.random / Date.now
 * -----------------------------------------
 * The sandbox forbids non-deterministic globals (Math.random, Date.now), so the
 * suffix is derived from process-local entropy that the kernel provides:
 *   - the PID (via the `process/getpid` syscall),
 *   - a monotonic per-process counter (incremented on every attempt),
 *   - optional caller-supplied entropy from $MKTEMP_SEED in the environment.
 * These are mixed with a small xorshift-style hash into a base-62 string filling
 * the template's `X` run. Collisions are handled by retrying with a bumped
 * counter (the suffix changes deterministically), so two calls in the same
 * process never collide and the result is reproducible given the same inputs.
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { mkdir, createFile, typeOf, joinPath } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A module-scoped monotonic counter — distinct per spawned guest process. */
let attemptCounter = 0;

/** Deterministically mix inputs into a base-62 string of length `n`. */
function entropy(pid: number, counter: number, seed: number, n: number): string {
  // xorshift32 seeded by mixing pid/counter/seed; advance once per output char.
  let x = (pid * 2654435761 + counter * 40503 + seed * 2246822519 + 0x9e3779b9) >>> 0;
  if (x === 0) x = 0x1a2b3c4d;
  let out = '';
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    out += ALPHABET[x % ALPHABET.length];
  }
  return out;
}

/** Replace the trailing run of `X`es in `template` with `fill`. */
function fillTemplate(template: string, fill: string): string {
  const m = /X+$/.exec(template);
  if (!m) return template;
  return template.slice(0, m.index) + fill.slice(0, m[0].length);
}

/** Count the trailing `X` run length. */
function xRun(template: string): number {
  const m = /X+$/.exec(template);
  return m ? m[0].length : 0;
}

async function getPid(io: CommandIO): Promise<number> {
  try {
    const { pid } = (await io.syscall('process/getpid', {})) as { pid: number };
    return pid;
  } catch {
    return 0;
  }
}

const mktempCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['d', 'u', 'q'],
    string: ['p', 'tmpdir', 'suffix'],
    alias: { directory: 'd', 'dry-run': 'u', quiet: 'q' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const quiet = Boolean(flags.q);

  try {
    const template = positionals[0] ?? 'tmp.XXXXXXXXXX';
    const nX = xRun(template);
    if (nX < 3) {
      if (!quiet) await writeLine(err, `mktemp: too few X's in template '${template}'`);
      return 1;
    }

    // Resolve the directory: -p / --tmpdir / $TMPDIR / /tmp. If the template is
    // absolute, honor it directly (GNU treats an absolute template as a path).
    const tmpdir = typeof flags.p === 'string' ? flags.p
      : typeof flags.tmpdir === 'string' && flags.tmpdir !== '' ? flags.tmpdir
        : io.env.TMPDIR || '/tmp';
    const base = template.startsWith('/') ? template : joinPath(tmpdir, template);

    const pid = await getPid(io);
    const seed = parseInt(io.env.MKTEMP_SEED ?? '', 10) || 0;
    // `--suffix=SUF`: appended after the filled template (GNU mktemp). The X run
    // stays the trailing run of `base`; the suffix lands after it.
    const suffix = typeof flags.suffix === 'string' ? flags.suffix : '';

    // Try a bounded number of candidates, bumping the counter each time.
    for (let attempt = 0; attempt < 1000; attempt++) {
      const fill = entropy(pid, ++attemptCounter, seed, nX);
      const candidate = fillTemplate(base, fill) + suffix;
      if (flags.u) { await writeLine(out, candidate); return 0; } // dry-run: don't create

      if ((await typeOf(io, candidate)) !== undefined) continue; // collision: retry
      try {
        if (flags.d) await mkdir(io, candidate);
        else await createFile(io, candidate);
        await writeLine(out, candidate);
        return 0;
      } catch (e) {
        // A racing create (EEXIST) → retry; any other error is fatal.
        if ((e as { code?: string }).code === 'EEXIST') continue;
        if (!quiet) await writeLine(err, `mktemp: failed to create ${flags.d ? 'directory' : 'file'} '${candidate}': ${(e as Error).message}`);
        return 1;
      }
    }
    if (!quiet) await writeLine(err, 'mktemp: could not create a unique name');
    return 1;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(mktempCommand);
export { mktempCommand, fillTemplate, entropy };

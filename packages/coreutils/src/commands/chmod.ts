/**
 * `chmod` — change file mode bits.
 *   Octal: `chmod 755 f`, `chmod 0644 f`
 *   Symbolic: `chmod u+x f`, `chmod go-w f`, `chmod a=r f`, `chmod u+x,g-w f`
 *   -R / --recursive : apply recursively into directories
 *   -v / --verbose   : describe each changed file
 *
 * Symbolic modes are applied relative to the file's current mode (read via
 * fs/stat), supporting who ∈ {u,g,o,a}, op ∈ {+,-,=}, perms ∈ {r,w,x}.
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { chmod, stat, readdir, joinPath, normalize } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const PERM_BITS: Record<string, number> = { r: 4, w: 2, x: 1 };

/** Parse an all-octal mode argument, or undefined if it isn't octal. */
function parseOctal(spec: string): number | undefined {
  return /^[0-7]{1,4}$/.test(spec) ? parseInt(spec, 8) : undefined;
}

/**
 * Apply a symbolic mode spec (e.g. `u+x,go-w`) to `current`, returning the new
 * mode. Returns undefined if the spec is not valid symbolic syntax.
 */
function applySymbolic(spec: string, current: number): number | undefined {
  let mode = current & 0o7777;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)([+\-=])([rwx]*)$/.exec(clause);
    if (!m) return undefined;
    const who = m[1] || 'a';
    const op = m[2];
    const perms = m[3];
    let permBits = 0;
    for (const p of perms) permBits |= PERM_BITS[p];

    // Expand the permission bits into the affected who-groups.
    let mask = 0;
    if (who.includes('u') || who.includes('a')) mask |= permBits << 6;
    if (who.includes('g') || who.includes('a')) mask |= permBits << 3;
    if (who.includes('o') || who.includes('a')) mask |= permBits;

    if (op === '+') mode |= mask;
    else if (op === '-') mode &= ~mask;
    else {
      // '=': clear the who-groups' bits, then set the new ones.
      let clear = 0;
      if (who.includes('u') || who.includes('a')) clear |= 0o700;
      if (who.includes('g') || who.includes('a')) clear |= 0o070;
      if (who.includes('o') || who.includes('a')) clear |= 0o007;
      mode = (mode & ~clear) | mask;
    }
  }
  return mode;
}

const chmodCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['R', 'v'],
    alias: { recursive: 'R', verbose: 'v' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  try {
    if (positionals.length < 2) {
      await writeLine(err, 'chmod: missing operand');
      return 1;
    }
    const spec = positionals[0];
    const files = positionals.slice(1);
    const octal = parseOctal(spec);

    for (const file of files) {
      try {
        await applyToPath(io, normalize(file), spec, octal, Boolean(flags.R), Boolean(flags.v), out, err);
      } catch (e) {
        await writeLine(err, `chmod: cannot access '${file}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

async function applyToPath(
  io: CommandIO, path: string, spec: string, octal: number | undefined, recursive: boolean,
  verbose: boolean, out: WritableStreamDefaultWriter<Uint8Array>, err: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const st = await stat(io, path);
  let newMode: number | undefined;
  if (octal !== undefined) {
    newMode = octal;
  } else {
    newMode = applySymbolic(spec, st.mode);
    if (newMode === undefined) {
      await writeLine(err, `chmod: invalid mode: '${spec}'`);
      return;
    }
  }
  await chmod(io, path, newMode);
  if (verbose) await writeLine(out, `mode of '${path}' changed to ${(newMode & 0o7777).toString(8).padStart(4, '0')}`);

  if (recursive && st.type === 'directory') {
    for (const entry of await readdir(io, path)) {
      await applyToPath(io, joinPath(path, entry.name), spec, octal, recursive, verbose, out, err);
    }
  }
}

export default defineCommand(chmodCommand);
export { chmodCommand, applySymbolic, parseOctal };

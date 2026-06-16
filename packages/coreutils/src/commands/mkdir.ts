/**
 * `mkdir` — create directories.
 *   -p / --parents  : create parent directories as needed; no error if it exists
 *   -m / --mode MODE: set the mode (octal) of created directories
 *   -v / --verbose  : print a line for each created directory
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { mkdir, chmod, typeOf, dirname, normalize } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Parse an octal mode string like "755" or "0644". Returns undefined if invalid. */
function parseMode(s: string): number | undefined {
  if (!/^[0-7]+$/.test(s)) return undefined;
  return parseInt(s, 8);
}

const mkdirCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['p', 'v'],
    string: ['m'],
    alias: { parents: 'p', mode: 'm', verbose: 'v' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  const mode = typeof flags.m === 'string' ? parseMode(flags.m) : undefined;
  if (typeof flags.m === 'string' && mode === undefined) {
    await writeLine(err, `mkdir: invalid mode: '${flags.m}'`);
    await out.close().catch(() => {}); await err.close().catch(() => {});
    return 1;
  }

  try {
    if (positionals.length === 0) {
      await writeLine(err, 'mkdir: missing operand');
      return 1;
    }
    for (const target of positionals) {
      const path = normalize(target);
      try {
        if (flags.p) {
          await mkdirParents(io, path, mode, Boolean(flags.v), out);
        } else {
          await mkdir(io, path);
          if (mode !== undefined) await chmod(io, path, mode);
          if (flags.v) await writeLine(out, `mkdir: created directory '${target}'`);
        }
      } catch (e) {
        await writeLine(err, `mkdir: cannot create directory '${target}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Create `path` and any missing ancestors. No error if any already exist. */
async function mkdirParents(
  io: CommandIO, path: string, mode: number | undefined, verbose: boolean,
  out: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const t = await typeOf(io, path);
  if (t === 'directory') return;
  const parent = dirname(path);
  if (parent !== path && parent !== '/' && parent !== '.') {
    await mkdirParents(io, parent, mode, verbose, out);
  }
  await mkdir(io, path);
  if (mode !== undefined) await chmod(io, path, mode);
  if (verbose) await writeLine(out, `mkdir: created directory '${path}'`);
}

export default defineCommand(mkdirCommand);
export { mkdirCommand };

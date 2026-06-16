/**
 * `realpath` — print the resolved (canonical) absolute path.
 *   -q / --quiet : suppress error messages for missing paths
 *   -m           : allow missing components (do not require the path to exist)
 *
 * Uses `fs/realpath`, falling back to a normalized path when the entry does not
 * exist and `-m` is given.
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { realpath, normalize } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const realpathCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['q', 'm', 'e', 's', 'P', 'L'],
    alias: { quiet: 'q' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  try {
    if (positionals.length === 0) {
      await writeLine(err, 'realpath: missing operand');
      return 1;
    }
    for (const p of positionals) {
      try {
        await writeLine(out, await realpath(io, p));
      } catch (e) {
        if (flags.m) {
          // -m: do not require existence — emit the normalized absolute path.
          await writeLine(out, normalize(absolutize(p, io.cwd)));
        } else {
          if (!flags.q) await writeLine(err, `realpath: ${p}: ${(e as Error).message}`);
          code = 1;
        }
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Make a path absolute against cwd (so -m output is canonical even for relatives). */
function absolutize(path: string, cwd: string): string {
  if (path.startsWith('/')) return path;
  const base = cwd || '/';
  return base.endsWith('/') ? base + path : base + '/' + path;
}

export default defineCommand(realpathCommand);
export { realpathCommand };

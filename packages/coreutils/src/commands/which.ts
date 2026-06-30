/**
 * `which` — locate a command by searching `$PATH`.
 *
 * For each NAME, scan the colon-separated `PATH` directories in order and print
 * the full path of the first entry that exists and is executable
 * (`stat.mode & 0o111`). With `-a`, print every match across `PATH` instead of
 * just the first. Exit 1 if any NAME has no executable match (GNU/BSD parity:
 * still prints the matches it did find).
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { stat, joinPath } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** True if `path` exists as a regular file with any execute bit set. */
async function isExecutable(io: CommandIO, path: string): Promise<boolean> {
  try {
    const st = await stat(io, path);
    return st.type === 'file' && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

const whichCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['a'],
    alias: { all: 'a' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const all = Boolean(flags.a);
  const dirs = (io.env.PATH ?? '').split(':').filter((d) => d !== '');
  try {
    let code = 0;
    for (const name of positionals) {
      let found = false;
      for (const dir of dirs) {
        const candidate = joinPath(dir, name);
        if (await isExecutable(io, candidate)) {
          await writeLine(out, candidate);
          found = true;
          if (!all) break;
        }
      }
      if (!found) code = 1;
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(whichCommand);
export { whichCommand };

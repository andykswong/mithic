/**
 * `copy` — the binary-fidelity workhorse: copy a file by path-args.
 *
 *   copy SRC DST
 *
 * Reads SRC and writes DST verbatim via the standard File System Access surface
 * (`readPath`/`writePath` over `guest.fs`), so bytes move by VFS path and never
 * traverse the string-typed shell. Unlike `cp`, `copy` is a path-arg utility
 * executable in the Lab sense: input/output are argv paths, resolved against the
 * process cwd.
 */
import { readPath, writePath } from '@mithic/guest-runtime';
import { defineCommand, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { pathContext } from '../path-context.ts';

const copyCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const [, src, dst] = io.args;
  const err = io.stderr.getWriter();
  try {
    if (src === undefined || dst === undefined) {
      await writeLine(err, 'copy: usage: copy SRC DST');
      return 1;
    }
    const g = pathContext(io);
    try {
      await writePath(g, dst, await readPath(g, src));
      return 0;
    } catch (e) {
      await writeLine(err, `copy: ${(e as Error).message}`);
      return 1;
    }
  } finally {
    await err.close().catch(() => {});
  }
};

export default defineCommand(copyCommand);
export { copyCommand };

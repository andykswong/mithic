/**
 * `rmdir` — remove empty directories.
 *   -p / --parents : also remove each successive parent component if it becomes
 *                    empty (rmdir -p a/b/c removes c, then b, then a).
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { rmdir, dirname, normalize } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const rmdirCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['p'],
    alias: { parents: 'p' },
  });
  const err = io.stderr.getWriter();
  let code = 0;
  try {
    if (positionals.length === 0) {
      await writeLine(err, 'rmdir: missing operand');
      return 1;
    }
    for (const target of positionals) {
      try {
        await rmdir(io, normalize(target));
        if (flags.p) {
          // Walk up, removing each parent while it is empty. Stop at the first
          // non-empty / error (matches GNU rmdir -p, which is silent on those).
          let cur = dirname(normalize(target));
          while (cur !== '/' && cur !== '.' && cur !== '') {
            try { await rmdir(io, cur); } catch { break; }
            cur = dirname(cur);
          }
        }
      } catch (e) {
        await writeLine(err, `rmdir: failed to remove '${target}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await err.close().catch(() => {});
  }
};

export default defineCommand(rmdirCommand);
export { rmdirCommand };

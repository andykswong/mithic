/**
 * `dirname` — strip the last component from each path operand.
 *
 *   dirname /a/b/c → /a/b
 *   dirname file   → .
 *   dirname /      → /
 *
 * `-z` separates outputs with NUL instead of newline.
 */
import { defineCommand, parseArgs, exitWith } from '../harness.ts';
import { dirname } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const dirnameCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['z'],
    alias: { zero: 'z' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const sep = flags.z ? '\x00' : '\n';
  try {
    if (positionals.length === 0) {
      return await exitWith(err, 1, 'dirname: missing operand');
    }
    for (const p of positionals) {
      await out.write(new TextEncoder().encode(dirname(p) + sep));
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(dirnameCommand);
export { dirnameCommand };

/**
 * `pwd` — print the working directory.
 *
 * The cwd is provided by the kernel on the guest boot (`io.cwd`). `-P` (resolve
 * symlinks) is accepted; since `io.cwd` is already kernel-normalized we treat it
 * the same as the logical default for the in-memory VFS.
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const pwdCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  // -L (logical) / -P (physical) are both accepted; output is io.cwd either way.
  parseArgs(io.args.slice(1), { boolean: ['L', 'P'] });
  const out = io.stdout.getWriter();
  try {
    await writeLine(out, io.cwd || '/');
    return 0;
  } finally {
    await out.close().catch(() => {});
  }
};

export default defineCommand(pwdCommand);
export { pwdCommand };

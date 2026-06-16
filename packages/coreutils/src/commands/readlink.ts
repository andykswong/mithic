/**
 * `readlink` — print the target of a symbolic link.
 *   -f / --canonicalize : canonicalize by following all symlinks (fs/realpath)
 *   -n                  : do not output the trailing newline
 */
import { defineCommand, parseArgs } from '../harness.ts';
import { readlink, realpath } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const readlinkCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['f', 'n'],
    alias: { canonicalize: 'f' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;
  const term = flags.n ? '' : '\n';

  try {
    if (positionals.length === 0) {
      await err.write(new TextEncoder().encode('readlink: missing operand\n'));
      return 1;
    }
    for (const p of positionals) {
      try {
        const value = flags.f ? await realpath(io, p) : await readlink(io, p);
        await out.write(new TextEncoder().encode(value + term));
      } catch {
        // GNU readlink prints nothing and returns 1 for a non-link / missing path.
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(readlinkCommand);
export { readlinkCommand };

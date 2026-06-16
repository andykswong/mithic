/**
 * `tee` — read stdin and write to stdout AND to each file operand.
 *
 * Supported:
 *   - file operands written via `fs/*` syscalls (open create+truncate, or append).
 *   - `-a` / `--append`: append to files instead of truncating.
 *   - always copies stdin to stdout.
 *
 * Requires write capability for the target paths.
 */
import { defineCommand, parseArgs, readAll, writeBytes, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const teeCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['a', 'append'],
    alias: { append: 'a' },
  });
  const name = io.args[0] ?? 'tee';
  const append = Boolean(flags.a);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;

  try {
    const data = await readAll(io.stdin);

    // Open each file (skipping ones that fail to open), writing data to all.
    for (const path of positionals) {
      try {
        const oflags = append
          ? { create: true, write: true, append: true }
          : { create: true, write: true, truncate: true };
        const { fd } = (await io.syscall('fs/open', { path, oflags })) as { fd: number };
        try {
          // Append mode relies on the fd's tracked offset; for truncate write at 0.
          if (append) await io.syscall('fs/write', { fd, data });
          else await io.syscall('fs/write', { fd, data, offset: 0 });
        } finally {
          await io.syscall('fs/close', { fd }).catch(() => {});
        }
      } catch (e) {
        const msg = (e as { message?: string }).message ?? 'cannot write';
        await writeString(err, `${name}: ${path}: ${msg}\n`);
        exitCode = 1;
      }
    }

    await writeBytes(out, data);
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(teeCommand);
export { teeCommand };

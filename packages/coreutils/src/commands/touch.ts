/**
 * `touch` — create empty files / update timestamps.
 *   -c / --no-create : do not create files that do not exist
 *   -a               : change only the access time
 *   -m               : change only the modification time
 *
 * Timestamps use the kernel clock (the kernel fills "now" when `fs/utimes` is
 * called without explicit times) — the guest never reads a wall clock itself.
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { createFile, stat, typeOf, isENOENT, AT_FDCWD } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const touchCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['c', 'a', 'm'],
    alias: { 'no-create': 'c' },
  });
  const err = io.stderr.getWriter();
  let code = 0;
  try {
    if (positionals.length === 0) {
      await writeLine(err, 'touch: missing file operand');
      return 1;
    }
    for (const path of positionals) {
      try {
        const exists = (await typeOf(io, path)) !== undefined;
        if (!exists) {
          if (flags.c) continue; // -c: skip nonexistent files
          await createFile(io, path);
        }
        // Bump times to "now". We never read a wall clock in the guest: omit the
        // times so the KERNEL fills its own clock (see fs/utimes). For partial
        // -a / -m we preserve the untouched side using the value the kernel
        // already reported via fs/stat (a kernel-sourced timestamp, not a guest
        // clock), keeping the guest free of Date.now/Date dependence.
        const onlyA = Boolean(flags.a) && !flags.m;
        const onlyM = Boolean(flags.m) && !flags.a;
        const utArgs: Record<string, unknown> = { dirfd: AT_FDCWD, path };
        if (onlyA || onlyM) {
          try {
            const st = await stat(io, path, false);
            if (onlyA) utArgs.mtime = new Date(st.mtime).getTime();
            if (onlyM) utArgs.atime = new Date(st.atime).getTime();
          } catch { /* fall back to kernel "now" for both */ }
        }
        await io.syscall('fs/utimes', utArgs);
      } catch (e) {
        if (isENOENT(e) && flags.c) continue;
        await writeLine(err, `touch: cannot touch '${path}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await err.close().catch(() => {});
  }
};

export default defineCommand(touchCommand);
export { touchCommand };

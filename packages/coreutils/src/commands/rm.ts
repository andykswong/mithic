/**
 * `rm` — remove files and directories.
 *   -r / -R / --recursive : remove directories and their contents recursively
 *   -f / --force          : ignore nonexistent operands, never error on missing
 *   -d / --dir            : remove empty directories
 *   -v / --verbose        : print each removed path
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { unlink, rmdir, readdir, typeOf, joinPath, normalize } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const rmCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['r', 'R', 'f', 'd', 'v'],
    alias: { recursive: 'r', force: 'f', dir: 'd', verbose: 'v' },
  });
  const recursive = Boolean(flags.r) || Boolean(flags.R);
  const force = Boolean(flags.f);
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  try {
    if (positionals.length === 0) {
      if (force) return 0;
      await writeLine(err, 'rm: missing operand');
      return 1;
    }
    for (const target of positionals) {
      const path = normalize(target);
      try {
        const t = await typeOf(io, path, false);
        if (t === undefined) {
          if (!force) { await writeLine(err, `rm: cannot remove '${target}': No such file or directory`); code = 1; }
          continue;
        }
        if (t === 'directory') {
          if (recursive) {
            await removeTree(io, path, Boolean(flags.v), out);
          } else if (flags.d) {
            await rmdir(io, path);
            if (flags.v) await writeLine(out, `removed directory '${target}'`);
          } else {
            await writeLine(err, `rm: cannot remove '${target}': Is a directory`);
            code = 1;
          }
        } else {
          await unlink(io, path);
          if (flags.v) await writeLine(out, `removed '${target}'`);
        }
      } catch (e) {
        if (!force) { await writeLine(err, `rm: cannot remove '${target}': ${(e as Error).message}`); code = 1; }
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Depth-first remove a directory and everything beneath it. */
async function removeTree(
  io: CommandIO, path: string, verbose: boolean, out: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const entries = await readdir(io, path);
  for (const entry of entries) {
    const child = joinPath(path, entry.name);
    if (entry.type === 'directory') {
      await removeTree(io, child, verbose, out);
    } else {
      await unlink(io, child);
      if (verbose) await writeLine(out, `removed '${child}'`);
    }
  }
  await rmdir(io, path);
  if (verbose) await writeLine(out, `removed directory '${path}'`);
}

export default defineCommand(rmCommand);
export { rmCommand };

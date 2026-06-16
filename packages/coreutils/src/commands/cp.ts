/**
 * `cp` — copy files and directories.
 *   -r / -R / --recursive : copy directories recursively
 *   -f / --force          : (best-effort) overwrite without prompting
 *   -p / --preserve       : preserve mode (and mtime where the VFS allows)
 *   -v / --verbose        : print "src -> dst" for each copy
 *
 * Multiple sources require the destination to be an existing directory.
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { readFile, writeFile, mkdir, readdir, stat, typeOf, chmod, basename, joinPath, normalize } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const cpCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['r', 'R', 'f', 'p', 'v'],
    alias: { recursive: 'r', force: 'f', preserve: 'p', verbose: 'v' },
  });
  const recursive = Boolean(flags.r) || Boolean(flags.R);
  const preserve = Boolean(flags.p);
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  try {
    if (positionals.length < 2) {
      await writeLine(err, positionals.length === 0 ? 'cp: missing file operand' : 'cp: missing destination file operand');
      return 1;
    }
    const dst = positionals[positionals.length - 1];
    const sources = positionals.slice(0, -1);
    const dstIsDir = (await typeOf(io, dst)) === 'directory';

    if (sources.length > 1 && !dstIsDir) {
      await writeLine(err, `cp: target '${dst}' is not a directory`);
      return 1;
    }

    for (const src of sources) {
      const target = dstIsDir ? joinPath(normalize(dst), basename(src)) : normalize(dst);
      try {
        await copyOne(io, normalize(src), target, recursive, preserve, Boolean(flags.v), out);
      } catch (e) {
        await writeLine(err, `cp: cannot copy '${src}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

async function copyOne(
  io: CommandIO, src: string, dst: string, recursive: boolean, preserve: boolean,
  verbose: boolean, out: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const st = await stat(io, src);
  if (st.type === 'directory') {
    if (!recursive) throw new Error('Is a directory (use -r)');
    // Create dst dir if absent, then recurse into children.
    if ((await typeOf(io, dst)) === undefined) await mkdir(io, dst);
    if (preserve) await chmod(io, dst, st.mode).catch(() => {});
    const entries = await readdir(io, src);
    for (const entry of entries) {
      await copyOne(io, joinPath(src, entry.name), joinPath(dst, entry.name), recursive, preserve, verbose, out);
    }
  } else {
    const bytes = await readFile(io, src);
    await writeFile(io, dst, bytes, preserve ? st.mode : undefined);
  }
  if (verbose) await writeLine(out, `'${src}' -> '${dst}'`);
}

export default defineCommand(cpCommand);
export { cpCommand };

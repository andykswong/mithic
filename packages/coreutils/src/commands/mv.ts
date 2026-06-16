/**
 * `mv` — move/rename files and directories.
 *   -f / --force   : do not prompt before overwriting (we never prompt)
 *   -n / --no-clobber : do not overwrite an existing destination
 *   -v / --verbose : print "src -> dst" for each move
 *
 * Multiple sources require the destination to be an existing directory.
 * Implemented with `fs/rename`; falls back to copy+delete across providers
 * (the kernel raises EXDEV/cross-device when rename can't span mounts).
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import {
  rename, readFile, writeFile, mkdir, readdir, unlink, rmdir, stat, typeOf, chmod,
  basename, joinPath, normalize, errnoOf,
} from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const mvCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['f', 'n', 'v'],
    alias: { force: 'f', 'no-clobber': 'n', verbose: 'v' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  try {
    if (positionals.length < 2) {
      await writeLine(err, positionals.length === 0 ? 'mv: missing file operand' : 'mv: missing destination file operand');
      return 1;
    }
    const dst = positionals[positionals.length - 1];
    const sources = positionals.slice(0, -1);
    const dstIsDir = (await typeOf(io, dst)) === 'directory';

    if (sources.length > 1 && !dstIsDir) {
      await writeLine(err, `mv: target '${dst}' is not a directory`);
      return 1;
    }

    for (const src of sources) {
      const target = dstIsDir ? joinPath(normalize(dst), basename(src)) : normalize(dst);
      try {
        if (flags.n && (await typeOf(io, target)) !== undefined) continue; // -n: keep existing
        await moveOne(io, normalize(src), target);
        if (flags.v) await writeLine(out, `'${src}' -> '${target}'`);
      } catch (e) {
        await writeLine(err, `mv: cannot move '${src}' to '${target}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

async function moveOne(io: CommandIO, src: string, dst: string): Promise<void> {
  try {
    await rename(io, src, dst);
    return;
  } catch (e) {
    // Cross-device rename: fall back to a recursive copy then delete the source.
    if (errnoOf(e) !== 'EXDEV') throw e;
  }
  await copyTree(io, src, dst);
  await removeTree(io, src);
}

async function copyTree(io: CommandIO, src: string, dst: string): Promise<void> {
  const st = await stat(io, src);
  if (st.type === 'directory') {
    if ((await typeOf(io, dst)) === undefined) await mkdir(io, dst);
    await chmod(io, dst, st.mode).catch(() => {});
    for (const entry of await readdir(io, src)) {
      await copyTree(io, joinPath(src, entry.name), joinPath(dst, entry.name));
    }
  } else {
    await writeFile(io, dst, await readFile(io, src), st.mode);
  }
}

async function removeTree(io: CommandIO, path: string): Promise<void> {
  if ((await typeOf(io, path, false)) === 'directory') {
    for (const entry of await readdir(io, path)) await removeTree(io, joinPath(path, entry.name));
    await rmdir(io, path);
  } else {
    await unlink(io, path);
  }
}

export default defineCommand(mvCommand);
export { mvCommand };

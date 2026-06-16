/**
 * `ln` — create links.
 *   -s / --symbolic : create a symbolic link instead of a hard link
 *   -f / --force    : remove an existing destination first
 *   -v / --verbose  : print the created link
 *
 * Forms: `ln [opts] TARGET LINK` or `ln [opts] TARGET... DIR` (link inside DIR).
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { symlink, link, unlink, typeOf, basename, joinPath, normalize } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const lnCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['s', 'f', 'v'],
    alias: { symbolic: 's', force: 'f', verbose: 'v' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  try {
    if (positionals.length < 1) {
      await writeLine(err, 'ln: missing file operand');
      return 1;
    }
    // Single operand: link in cwd with the target's basename.
    let targets: string[];
    let dest: string;
    if (positionals.length === 1) {
      targets = [positionals[0]];
      dest = basename(positionals[0]);
    } else {
      dest = positionals[positionals.length - 1];
      targets = positionals.slice(0, -1);
    }
    const destIsDir = (await typeOf(io, dest)) === 'directory';
    if (targets.length > 1 && !destIsDir) {
      await writeLine(err, `ln: target '${dest}' is not a directory`);
      return 1;
    }

    for (const target of targets) {
      const linkPath = destIsDir ? joinPath(normalize(dest), basename(target)) : normalize(dest);
      try {
        if (flags.f) await unlink(io, linkPath).catch(() => { /* nothing to remove */ });
        if (flags.s) {
          // Symlink target is stored verbatim (may be relative / dangling).
          await symlink(io, target, linkPath);
        } else {
          await link(io, normalize(target), linkPath);
        }
        if (flags.v) await writeLine(out, `'${linkPath}' -> '${target}'`);
      } catch (e) {
        await writeLine(err, `ln: failed to create link '${linkPath}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(lnCommand);
export { lnCommand };

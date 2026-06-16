/**
 * `basename` — strip directory and (optionally) a suffix from a path.
 *
 * Forms:
 *   basename NAME [SUFFIX]   — strip dir; if SUFFIX matches the tail, strip it too
 *   basename -a NAME...      — print the basename of each NAME
 *   basename -s SUF NAME...  — implies -a; strip SUF from each NAME
 */
import { defineCommand, parseArgs, exitWith } from '../harness.ts';
import { basename } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Remove `suffix` from `name`, but never reduce the name to empty. */
function stripSuffix(name: string, suffix: string): string {
  if (suffix && name !== suffix && name.endsWith(suffix)) return name.slice(0, -suffix.length);
  return name;
}

const basenameCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['a', 'z'],
    string: ['s'],
    alias: { multiple: 'a', suffix: 's', zero: 'z' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const sep = flags.z ? '\x00' : '\n';
  const writeOut = (s: string): Promise<void> => out.write(new TextEncoder().encode(s + sep));

  try {
    if (positionals.length === 0) {
      return await exitWith(err, 1, 'basename: missing operand');
    }
    const multiple = Boolean(flags.a) || typeof flags.s === 'string';
    if (multiple) {
      const suffix = typeof flags.s === 'string' ? flags.s : '';
      for (const name of positionals) {
        await writeOut(stripSuffix(basename(name), suffix));
      }
    } else {
      // Single form: basename NAME [SUFFIX]
      if (positionals.length > 2) {
        return await exitWith(err, 1, `basename: extra operand '${positionals[2]}'`);
      }
      const suffix = positionals[1] ?? '';
      await writeOut(stripSuffix(basename(positionals[0]), suffix));
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(basenameCommand);
export { basenameCommand };

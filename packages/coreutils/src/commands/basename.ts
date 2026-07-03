/**
 * `basename` — strip directory and (optionally) a suffix from a path.
 *
 * Forms:
 *   basename NAME [SUFFIX]   — strip dir; if SUFFIX matches the tail, strip it too
 *   basename -a NAME...      — print the basename of each NAME
 *   basename -s SUF NAME...  — implies -a; strip SUF from each NAME
 */
import { defineCommand, parseArgs, exitWith, optionError } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/**
 * POSIX `basename`: strip trailing slashes, then take the final path component.
 * A path that is entirely slashes (`/`, `//`, `///`) is `/`; an empty string is
 * empty. Internal multiple slashes are irrelevant (only the tail after the last
 * slash matters). This is the POSIX/GNU algorithm — the shared `fs.basename`
 * helper mishandles the all-slash case (`//` → `''`), so basename uses its own.
 */
function posixBasename(path: string): string {
  if (path === '') return '';
  // Trim trailing slashes.
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  if (end === 0) return '/'; // string was all slashes
  // Find the start of the last component.
  let start = end;
  while (start > 0 && path[start - 1] !== '/') start--;
  return path.slice(start, end);
}

/** Remove `suffix` from `name`, but never reduce the name to empty. */
function stripSuffix(name: string, suffix: string): string {
  if (suffix && name !== suffix && name.endsWith(suffix)) return name.slice(0, -suffix.length);
  return name;
}

const basenameCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'basename';
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['a', 'z'],
    string: ['s'],
    alias: { multiple: 'a', suffix: 's', zero: 'z' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const sep = flags.z ? '\x00' : '\n';
  const writeOut = (s: string): Promise<void> => out.write(new TextEncoder().encode(s + sep));

  try {
    if (parsed.unknown.length) {
      return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    }
    if (positionals.length === 0) {
      return await exitWith(err, 1, 'basename: missing operand');
    }
    const multiple = Boolean(flags.a) || typeof flags.s === 'string';
    if (multiple) {
      const suffix = typeof flags.s === 'string' ? flags.s : '';
      for (const name of positionals) {
        await writeOut(stripSuffix(posixBasename(name), suffix));
      }
    } else {
      // Single form: basename NAME [SUFFIX]
      if (positionals.length > 2) {
        return await exitWith(err, 1, `basename: extra operand '${positionals[2]}'`);
      }
      const suffix = positionals[1] ?? '';
      await writeOut(stripSuffix(posixBasename(positionals[0]), suffix));
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(basenameCommand);
export { basenameCommand, posixBasename };

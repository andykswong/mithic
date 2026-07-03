/**
 * `dirname` — strip the last component from each path operand.
 *
 *   dirname /a/b/c   → /a/b
 *   dirname file     → .
 *   dirname /        → /
 *   dirname a//b//c  → a//b   (internal duplicate slashes are preserved)
 *   dirname foo//    → .
 *   dirname //foo    → /
 *
 * `-z` separates outputs with NUL instead of newline.
 */
import { defineCommand, parseArgs, exitWith, optionError } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/**
 * POSIX `dirname` (matching GNU): trim trailing slashes, drop the last
 * component, then trim trailing slashes from what remains. A path with no slash
 * → `.`; a result that collapses to empty is `/` when the path was rooted, else
 * `.`. Internal duplicate slashes in the surviving prefix are preserved
 * (`a//b//c` → `a//b`). The shared `fs.dirname` collapses these, so dirname uses
 * its own POSIX implementation.
 */
function posixDirname(path: string): string {
  // Trim trailing slashes from the whole path.
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  if (end === 0) return path.length > 0 ? '/' : '.'; // all-slashes → '/', empty → '.'
  // Find the last slash within the trimmed region → start of the final component.
  let slash = end;
  while (slash > 0 && path[slash - 1] !== '/') slash--;
  if (slash === 0) return '.'; // no slash before the final component
  // Drop the final component; trim trailing slashes from the prefix.
  let dirEnd = slash;
  while (dirEnd > 0 && path[dirEnd - 1] === '/') dirEnd--;
  if (dirEnd === 0) return '/'; // prefix was all leading slashes (e.g. //foo)
  return path.slice(0, dirEnd);
}

const dirnameCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'dirname';
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['z'],
    alias: { zero: 'z' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const sep = flags.z ? '\x00' : '\n';
  try {
    if (parsed.unknown.length) {
      return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    }
    if (positionals.length === 0) {
      return await exitWith(err, 1, 'dirname: missing operand');
    }
    for (const p of positionals) {
      await out.write(new TextEncoder().encode(posixDirname(p) + sep));
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(dirnameCommand);
export { dirnameCommand, posixDirname };

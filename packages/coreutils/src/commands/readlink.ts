/**
 * `readlink` — print the target of a symbolic link.
 *   (no flag)           : print the raw link target (fails on a non-link)
 *   -f / --canonicalize : canonicalize, requiring all but the LAST component to
 *                         exist (the final component may be missing)
 *   -e / --canonicalize-existing : canonicalize, requiring EVERY component
 *                         (including the last) to exist
 *   -m / --canonicalize-missing  : canonicalize, requiring NO component to exist
 *   -n                  : do not output the trailing newline
 *   -q / -s / --quiet / --silent : suppress most error messages (default here)
 */
import { defineCommand, parseArgs, exitWith, optionError } from '../harness.ts';
import { readlink, normalize } from '../fs.ts';
import { canonicalize } from './canonicalize.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

type Mode = 'f' | 'e' | 'm';

const readlinkCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['f', 'e', 'm', 'n', 'q', 's', 'v', 'z'],
    alias: {
      canonicalize: 'f', 'canonicalize-existing': 'e', 'canonicalize-missing': 'm',
      quiet: 'q', silent: 's', verbose: 'v', 'no-newline': 'n', zero: 'z',
    },
    unknown: 'error',
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const name = io.args[0] ?? 'readlink';
  const enc = new TextEncoder();
  let code = 0;
  const flags = parsed.flags;
  const term = flags.n ? '' : (flags.z ? '\x00' : '\n');
  // Any of -f/-e/-m enables canonicalization; the most specific wins the mode.
  const mode: Mode | undefined = flags.e ? 'e' : flags.m ? 'm' : flags.f ? 'f' : undefined;

  try {
    if (parsed.unknown.length) {
      return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    }
    if (parsed.positionals.length === 0) {
      return await exitWith(err, 1, `${name}: missing operand\nTry '${name} --help' for more information.`);
    }
    for (const p of parsed.positionals) {
      try {
        let value: string | undefined;
        if (mode !== undefined) {
          // -f/-e/-m: canonicalize with our own walker. The kernel's fs/realpath
          // tolerates a missing final component, so it cannot enforce -e's
          // all-must-exist rule — the walker does that.
          value = await canonicalize(io, normalize(absolutize(p, io.cwd)), mode);
        } else {
          value = await readlink(io, p);
        }
        if (value === undefined) { code = 1; continue; }
        await out.write(enc.encode(value + term));
      } catch {
        // GNU (with -q, the default here) prints nothing and returns 1.
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Make a path absolute against cwd. */
function absolutize(path: string, cwd: string): string {
  if (path.startsWith('/')) return path;
  const base = cwd || '/';
  return base.endsWith('/') ? base + path : base + '/' + path;
}

export default defineCommand(readlinkCommand);
export { readlinkCommand };

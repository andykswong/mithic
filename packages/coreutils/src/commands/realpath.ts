/**
 * `realpath` — print the resolved (canonical) absolute path.
 *   (default)    : all components except the LAST must exist (like readlink -f)
 *   -e / --canonicalize-existing : every component including the last must exist
 *   -m / --canonicalize-missing  : no component need exist
 *   -q / --quiet : suppress error messages for missing paths
 *   -z / --zero  : end each output line with NUL instead of a newline
 *   --relative-to=DIR   : print the resolved path relative to (resolved) DIR
 *   --relative-base=DIR : print relative to DIR only when the path is under DIR,
 *                         otherwise print the absolute resolved path
 *   -s / -P / -L : accepted (symlink handling variants); the canonical resolver
 *                  already follows symlinks.
 */
import { defineCommand, parseArgs, writeString, exitWith, optionError } from '../harness.ts';
import { normalize } from '../fs.ts';
import { canonicalize, CanonError } from './canonicalize.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const realpathCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['q', 'm', 'e', 's', 'P', 'L', 'z'],
    string: ['relative-to', 'relative-base'],
    alias: {
      quiet: 'q', 'canonicalize-missing': 'm', 'canonicalize-existing': 'e',
      strip: 's', 'no-symlinks': 's', 'physical': 'P', 'logical': 'L', zero: 'z',
    },
    unknown: 'error',
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const name = io.args[0] ?? 'realpath';
  const flags = parsed.flags;
  let code = 0;
  const term = flags.z ? '\x00' : '\n';
  // Mode: -e (all exist) > -m (none) > default (all-but-last).
  const mode: 'e' | 'm' | 'f' = flags.e ? 'e' : flags.m ? 'm' : 'f';

  try {
    if (parsed.unknown.length) {
      return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    }
    if (parsed.positionals.length === 0) {
      return await exitWith(err, 1, `${name}: missing operand\nTry '${name} --help' for more information.`);
    }
    // Resolve the relative anchors once. `--relative-base` implies the base is
    // also the relative-to root (GNU: -to defaults to the base when only base
    // is given).
    const baseArg = typeof flags['relative-base'] === 'string' ? flags['relative-base'] : undefined;
    const toArg = typeof flags['relative-to'] === 'string' ? flags['relative-to']
      : baseArg !== undefined ? baseArg : undefined;
    const canonBase = baseArg !== undefined ? await canonSafe(io, baseArg, mode) : undefined;
    const canonTo = toArg !== undefined ? await canonSafe(io, toArg, mode) : undefined;

    for (const p of parsed.positionals) {
      try {
        const resolved = await canonicalize(io, absolutize(p, io.cwd), mode);
        let display = resolved;
        // --relative-base: only relativize when `resolved` is inside the base.
        const inBase = canonBase === undefined || isWithin(resolved, canonBase);
        if (canonTo !== undefined && inBase) {
          display = relativeTo(resolved, canonTo);
        }
        await writeString(out, display + term);
      } catch (e) {
        if (e instanceof CanonError) {
          if (!flags.q) await writeString(err, `${name}: ${p}: No such file or directory\n`);
          code = 1;
        } else {
          if (!flags.q) await writeString(err, `${name}: ${p}: ${(e as Error).message}\n`);
          code = 1;
        }
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Canonicalize an anchor path; never throws (a missing anchor → its normalized form). */
async function canonSafe(io: CommandIO, path: string, mode: 'e' | 'm' | 'f'): Promise<string> {
  try { return await canonicalize(io, normalize(absolutize(path, io.cwd)), mode); }
  catch { return normalize(absolutize(path, io.cwd)); }
}

/** Make a path absolute against cwd. */
function absolutize(path: string, cwd: string): string {
  if (path.startsWith('/')) return path;
  const base = cwd || '/';
  return base.endsWith('/') ? base + path : base + '/' + path;
}

/** True if `path` is `base` itself or lies within `base`. */
function isWithin(path: string, base: string): boolean {
  if (path === base) return true;
  const b = base === '/' ? '/' : base + '/';
  return path.startsWith(b);
}

/**
 * Compute `path` expressed relative to `from` (both absolute, canonical),
 * matching GNU `--relative-to`: shared-prefix length, then `..` for each
 * remaining `from` segment plus the `path` tail. Equal paths → `.`.
 */
function relativeTo(path: string, from: string): string {
  const p = path.split('/').filter(Boolean);
  const f = from.split('/').filter(Boolean);
  let i = 0;
  while (i < p.length && i < f.length && p[i] === f[i]) i++;
  const up = f.slice(i).map(() => '..');
  const down = p.slice(i);
  const parts = [...up, ...down];
  return parts.length === 0 ? '.' : parts.join('/');
}

export default defineCommand(realpathCommand);
export { realpathCommand, relativeTo, isWithin };

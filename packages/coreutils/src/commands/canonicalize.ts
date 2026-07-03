/**
 * Shared path canonicalizer for `readlink -f/-e/-m` and `realpath`.
 *
 * The VFS `fs/realpath` is all-or-nothing (it throws if any component is
 * missing), but GNU `readlink -f`/`-m` and `realpath` (default / `-m`) resolve
 * as much as exists and then append the still-missing tail. This walker mirrors
 * the coreutils `canonicalize_filename_mode` behavior:
 *
 *   - `'existing'` (`-e`): every component, including the last, must exist.
 *   - `'all-but-last'` (`-f`, and `realpath` default): every component except
 *     the last must exist; the last may be missing.
 *   - `'missing'` (`-m`): no component need exist.
 *
 * Symlinks encountered along the existing prefix are followed (with a loop
 * guard). Missing components are normalized (`.`/`..` collapsed) and appended.
 */
import { stat, readlink } from '../fs.ts';
import type { CommandIO } from '../harness.ts';

export type CanonMode = 'existing' | 'all-but-last' | 'missing';

const MAX_LINKS = 40;

/** Thrown when a required component does not exist for the given mode. */
export class CanonError extends Error {
  readonly path: string;
  constructor(path: string) {
    super('No such file or directory');
    this.name = 'CanonError';
    this.path = path;
  }
}

/**
 * Canonicalize `input` (which MUST already be absolute) to a symlink-free
 * absolute path per `mode`. Throws {@link CanonError} when a component required
 * by the mode is missing.
 */
export async function canonicalize(io: CommandIO, input: string, modeFlag: 'f' | 'e' | 'm' | CanonMode): Promise<string> {
  const mode: CanonMode = modeFlag === 'f' ? 'all-but-last'
    : modeFlag === 'e' ? 'existing'
      : modeFlag === 'm' ? 'missing'
        : modeFlag;

  // Remaining components to process (a stack, reversed so pop() takes the head).
  const rest = input.split('/').filter((s) => s !== '');
  const resolved: string[] = []; // resolved absolute components (symlink-free)
  let links = 0;

  // Process components left-to-right.
  while (rest.length > 0) {
    const comp = rest.shift()!;
    if (comp === '.') continue;
    if (comp === '..') { if (resolved.length > 0) resolved.pop(); continue; }

    const candidate = '/' + [...resolved, comp].join('/');
    const isLast = rest.length === 0;
    let st;
    try {
      st = await stat(io, candidate, false); // lstat
    } catch {
      // Component missing. Enforce the mode's existence requirement.
      if (mode === 'existing') throw new CanonError(candidate);
      if (mode === 'all-but-last' && !isLast) throw new CanonError(candidate);
      // Otherwise (missing mode, or the final component in all-but-last):
      // append this and every remaining component verbatim (already normalized
      // of `.`; `..` in the missing tail is collapsed lexically below).
      resolved.push(comp);
      for (const r of rest) {
        if (r === '.') continue;
        if (r === '..') { if (resolved.length > 0) resolved.pop(); continue; }
        resolved.push(r);
      }
      rest.length = 0;
      break;
    }

    if (st.type === 'symlink') {
      if (++links > MAX_LINKS) throw new CanonError(candidate);
      const target = await readlink(io, candidate);
      const targetParts = target.startsWith('/')
        ? target.split('/').filter((s) => s !== '')
        : target.split('/').filter((s) => s !== '');
      if (target.startsWith('/')) resolved.length = 0; // absolute target resets
      // Re-process the (possibly relative) target components before continuing.
      rest.unshift(...targetParts);
      continue;
    }

    resolved.push(comp);
  }

  return '/' + resolved.join('/');
}

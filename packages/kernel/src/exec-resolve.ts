/**
 * Pure exec-from-VFS resolution helpers (RFC 0001 §4.2): the decision logic for
 * the Unix `binfmt` model — shebang parsing, the per-interpreter format table,
 * and 3-layer name resolution. No I/O and no Kernel/VFS deref: the caller injects
 * `exists` (a VFS lookup) and the `builtins`/`pathDirs` it knows. The kernel deref
 * (read bytes, stat, getxattr) stays in syscall-dispatch / kernel.
 */

/** The interpreter (and optional single arg) named by a leading `#!` line. */
export interface Shebang {
  interpreter: string;
  arg?: string;
}

/**
 * Parse a leading `#!` line. The shebang must start at byte 0 (POSIX). Returns
 * `undefined` when the source has no shebang. A single optional argument after
 * the interpreter is captured (e.g. `#!/usr/bin/env node`).
 */
export function parseShebang(source: string): Shebang | undefined {
  if (!source.startsWith('#!')) return undefined;
  const newline = source.indexOf('\n');
  const line = newline === -1 ? source : source.slice(0, newline);
  const rest = line.slice(2).trim();
  if (rest === '') return undefined;
  const [interpreter, ...args] = rest.split(/\s+/);
  return args.length > 0 ? { interpreter, arg: args.join(' ') } : { interpreter };
}

/** How an executable file is run, per the fixed per-interpreter format table. */
export type Classification =
  | { kind: 'guest' }
  | { kind: 'interpreter'; interpreter: string };

/**
 * The `binfmt`-style format table (keyed by interpreter, not command). A
 * `#!/bin/node` shebang or no shebang at all is the default JS guest case; any
 * other interpreter is re-resolved by the caller and run as `interpreter <file>`.
 */
export function classifyExecutable(source: string): Classification {
  const shebang = parseShebang(source);
  if (!shebang) return { kind: 'guest' };
  // `#!/usr/bin/env X` defers to X as the real interpreter (the env indirection).
  // Compare the basename so `/usr/bin/env` and a bare `env` both match.
  const base = shebang.interpreter.slice(shebang.interpreter.lastIndexOf('/') + 1);
  const interpreter = base === 'env' && shebang.arg ? shebang.arg : shebang.interpreter;
  if (interpreter === '/bin/node' || interpreter === 'node') return { kind: 'guest' };
  return { kind: 'interpreter', interpreter };
}

export interface ResolveNameOptions {
  /** In-process shell builtins — resolved first and never spawned. */
  builtins: ReadonlySet<string>;
  /** `$PATH` directories, in search order. */
  pathDirs: readonly string[];
  /** VFS existence probe (injected; the resolver does no I/O). */
  exists: (path: string) => boolean;
}

/** The outcome of 3-layer name resolution. */
export type Resolution =
  | { layer: 'builtin' }
  | { layer: 'file'; path: string }
  | { layer: 'not-found' };

function isExplicitPath(name: string): boolean {
  return name.startsWith('/') || name.startsWith('./') || name.startsWith('../');
}

/**
 * 3-layer resolution: an explicit path (`/…`, `./…`, `../…`) is used directly
 * when it exists. A bare name resolves first against shell builtins, then by
 * walking `$PATH` for a matching VFS file, else `not-found`. Host/special command
 * resolution is the caller's third layer (it owns `resolveCommand`).
 */
export function resolveName(name: string, options: ResolveNameOptions): Resolution {
  if (isExplicitPath(name)) {
    return options.exists(name) ? { layer: 'file', path: name } : { layer: 'not-found' };
  }
  if (options.builtins.has(name)) return { layer: 'builtin' };
  for (const dir of options.pathDirs) {
    const path = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
    if (options.exists(path)) return { layer: 'file', path };
  }
  return { layer: 'not-found' };
}

/**
 * jq's `resolveCommand`-compatible registry, mirroring `@mithic/coreutils`.
 *
 * A host registers jq with the kernel by giving it a `resolveCommand` that maps
 * the name `"jq"` to the `file://` URL of the BUILT guest module (`dist/jq.js`),
 * which the kernel's launcher imports with normal ESM resolution. {@link resolveJq}
 * returns that URL for `"jq"` and `undefined` otherwise (→ kernel ENOENT).
 *
 * ```ts
 * import { resolveJq } from '@mithic/jq';
 * const kernel = new Kernel({ runtime, vfs, resolveCommand: resolveJq });
 * // …or compose with other resolvers:
 * const resolveCommand = (name, cwd, env) =>
 *   resolveJq(name, cwd, env) ?? createCoreutilsResolver()(name, cwd, env);
 * ```
 *
 * REQUIRES the package to be built (`npm run build -w @mithic/jq`) so `dist/jq.js`
 * exists. This file builds to `dist/resolver.js`, so `./jq.js` relative to it is
 * the built guest module; under vitest (running from `src/`) we hop to `../dist/jq.js`.
 */

/** The command name this package provides. */
export const COMMAND_NAMES = ['jq'] as const;

/** Options for {@link createJqResolver}. */
export interface JqResolverOptions {
  /** Base URL the command module is resolved against. Defaults to this module. */
  baseUrl?: string | URL;
}

/**
 * Build a `resolveCommand(name, cwd, env)` that resolves `"jq"` to its built
 * guest module URL. Use this (or {@link resolveJq}) in `new Kernel({ resolveCommand })`.
 */
export function createJqResolver(
  options: JqResolverOptions = {},
): (name: string, cwd: string, env: Record<string, string>) => URL | undefined {
  const fromSrc = import.meta.url.includes('/src/');
  const base = options.baseUrl ?? import.meta.url;
  return function resolveCommand(name: string): URL | undefined {
    if (name !== 'jq') return undefined;
    const rel = fromSrc ? '../dist/jq.js' : './jq.js';
    return new URL(rel, base);
  };
}

/** A ready-to-use {@link createJqResolver} instance (default layout). */
export const resolveJq = createJqResolver();

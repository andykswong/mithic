/**
 * The `@mithic/curl` command registry / `resolveCommand` factory.
 *
 * The kernel resolves a bare command NAME to spawnable guest code via
 * `KernelOptions.resolveCommand(name, cwd, env) => string | URL | undefined`.
 * {@link createCurlResolver} returns such a function: it maps the `curl` name to
 * the `file://` URL of the BUILT guest module (`dist/curl.js`), which the
 * kernel's launcher imports with normal ESM resolution. An unknown name returns
 * `undefined`, so the kernel yields ENOENT. Mirrors `@mithic/coreutils`'
 * `createCoreutilsResolver`, except curl is a single top-level module
 * (`src/curl.ts` → `dist/curl.js`) rather than a `commands/<name>.js` set.
 *
 * Host registration:
 * ```ts
 * import { Kernel } from '@mithic/kernel';
 * import { createCurlResolver } from '@mithic/curl';
 * import { FetchHttpClient } from '@mithic/io/net';
 *
 * const kernel = new Kernel({
 *   runtime, vfs,
 *   resolveCommand: createCurlResolver(),  // (compose with other resolvers as needed)
 *   httpClient: new FetchHttpClient(),     // optional — this is the kernel default
 * });
 * // A guest spawned with `{ type: 'net', origins: ['https://api.example.com'] }`
 * // can `curl https://api.example.com/…`; any other origin is EACCES.
 * ```
 */

/** The set of command names this package provides. */
export const COMMAND_NAMES = ['curl'] as const;

export type CurlCommandName = typeof COMMAND_NAMES[number];

/** Options for {@link createCurlResolver}. */
export interface CurlResolverOptions {
  /**
   * Base URL the command module is resolved against. Defaults to this module's
   * own location, so it points at `dist/curl.js` whether the package runs from
   * `dist` (published) or `src` (vitest, via the `../dist` hop). Override only
   * for unusual hosting layouts.
   */
  baseUrl?: string | URL;
  /** Restrict to a subset of {@link COMMAND_NAMES}. Defaults to all (just `curl`). */
  only?: readonly string[];
}

/**
 * Build a `resolveCommand(name, cwd, env)` suitable for `new Kernel({ resolveCommand })`.
 * Returns the `file://` URL of `dist/curl.js` for the `curl` name, or `undefined`
 * for any other name (→ kernel ENOENT).
 */
export function createCurlResolver(
  options: CurlResolverOptions = {},
): (name: string, cwd: string, env: Record<string, string>) => URL | undefined {
  const available = new Set(options.only ?? COMMAND_NAMES);
  // This file builds to `dist/resolver.js`, so `./<name>.js` relative to it is
  // `dist/<name>.js`. Under vitest, import.meta.url is `…/src/resolver.ts`; hop
  // to `../dist/<name>.js` for the built command module.
  const fromSrc = import.meta.url.includes('/src/');
  const base = options.baseUrl ?? import.meta.url;

  return function resolveCommand(name: string): URL | undefined {
    if (!available.has(name)) return undefined;
    const rel = fromSrc ? `../dist/${name}.js` : `./${name}.js`;
    return new URL(rel, base);
  };
}

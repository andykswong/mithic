/**
 * The coreutils command registry / `resolveCommand` factory.
 *
 * The kernel resolves a bare command NAME to spawnable guest code via
 * `KernelOptions.resolveCommand(name, cwd, env) => string | URL | undefined`.
 * {@link createCoreutilsResolver} returns such a function: it maps a known
 * coreutils name to the `file://` URL of that command's BUILT guest module
 * (`dist/commands/<name>.js`), which the kernel's launcher imports with normal
 * ESM resolution (exactly how the shell's own `dist/process.js` is launched).
 * An unknown name returns `undefined`, so the kernel yields ENOENT.
 *
 * Delivery mechanism (the key design decision): each command is its OWN built
 * module under `dist/commands/`. The repo's vite config uses `preserveModules`,
 * so `src/commands/cat.ts` builds 1:1 to `dist/commands/cat.js`. Resolving a
 * name to that module's URL means the launcher imports a real file with working
 * `import { … } from '@mithic/guest-runtime'` resolution — no runtime code-string
 * assembly, no bundling surprises. This mirrors the shell package precisely.
 */

/**
 * The set of command names this package provides. Each name MUST have a
 * corresponding `src/commands/<name>.ts` whose default export is
 * `defineCommand(fn)`. Later batches extend this list as they add commands.
 */
export const COMMAND_NAMES = ['cat', 'grep', 'egrep', 'fgrep', 'sed'] as const;

export type CoreutilsCommandName = typeof COMMAND_NAMES[number];

/** Options for {@link createCoreutilsResolver}. */
export interface CoreutilsResolverOptions {
  /**
   * Base URL the command modules are resolved against. Defaults to this
   * module's own location, so it points at `dist/commands/<name>.js` whether the
   * package runs from `dist` (published) or `src` (vitest, via the `../dist`
   * hop below). Override only for unusual hosting layouts.
   */
  baseUrl?: string | URL;
  /**
   * Restrict the resolver to a subset of {@link COMMAND_NAMES}. Useful for tests
   * or for hosts that want to expose only some coreutils. Defaults to all.
   */
  only?: readonly string[];
}

/**
 * Build a `resolveCommand(name, cwd, env)` suitable for `new Kernel({ resolveCommand })`.
 *
 * Returns the `file://` URL of `dist/commands/<name>.js` for a known command, or
 * `undefined` for an unknown name (→ kernel ENOENT). The returned URL is what the
 * kernel's `DefaultGuestLauncher` imports to run the command as a guest process.
 */
export function createCoreutilsResolver(
  options: CoreutilsResolverOptions = {},
): (name: string, cwd: string, env: Record<string, string>) => URL | undefined {
  const available = new Set(options.only ?? COMMAND_NAMES);
  // Resolve to the built dist modules. This file builds to `dist/resolver.js`,
  // so `./commands/<name>.js` relative to it is `dist/commands/<name>.js`.
  // When running from src under vitest, import.meta.url is `…/src/resolver.ts`;
  // we hop to `../dist/commands/<name>.js` for the built command module.
  const fromSrc = import.meta.url.includes('/src/');
  const base = options.baseUrl ?? import.meta.url;

  return function resolveCommand(name: string): URL | undefined {
    if (!available.has(name)) return undefined;
    const rel = fromSrc ? `../dist/commands/${name}.js` : `./commands/${name}.js`;
    return new URL(rel, base);
  };
}

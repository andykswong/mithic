/**
 * Vite plugin: `?bundle` — import a guest module's *self-contained source text*.
 *
 *   import imgresizeSrc from '../../../coreutils/src/commands/imgresize.ts?bundle';
 *
 * yields the module bundled into a single classic-script IIFE that inlines every
 * dependency (notably `@mithic/guest-runtime`) and ends with
 * `globalThis.__mithic_default = <module>.default;`.
 *
 * THE LOAD-BEARING REASON (RFC 0001 §4.2). The Lab installs utilities into
 * `/usr/bin` and the kernel runs them via exec-from-VFS: it reads the file's
 * bytes, strips the `#!/bin/node` shebang, and hands the SOURCE to the launcher.
 * On the Lab's `WorkerRuntime` that source is `(0, eval)`-d in a bare worker —
 * NOT `import()`-ed as a module. So the installed bytes must be:
 *   1. dependency-inlined (a bare `import '@mithic/guest-runtime'` cannot resolve
 *      in an opaque worker — the documented "browser loading problem"), and
 *   2. a classic script that assigns `globalThis.__mithic_default` (an ESM
 *      `export default` is a syntax error under `eval`).
 * The U-phase utilities are `defineCommand`-wrapped ESM modules with bare imports
 * and `export default` — neither runnable form. This plugin produces the runnable
 * form at build time with esbuild, so the SAME modules the in-process command
 * suite imports also install as genuinely exec-from-VFS-runnable executables.
 *
 * The plugin runs under every Vite that loads the Lab — `vite build`, `vite dev`,
 * and `vitest --project browser` — so the registry is consistent everywhere.
 */
import { build } from 'esbuild';
import type { Plugin } from 'vite';

const SUFFIX = '?bundle';
const SUFFIX_ESM = '?bundle-esm';

/** Bundle one entry into a `globalThis.__mithic_default`-assigning IIFE. */
async function bundleGuest(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: '__mithic_module',
    platform: 'browser',
    target: 'esnext',
    write: false,
    legalComments: 'none',
    footer: { js: 'globalThis.__mithic_default = __mithic_module.default;' },
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/**
 * Bundle one entry into a self-contained ESM module (named exports preserved). Used for G2
 * dependency bytes (e.g. @mithic/guest-runtime), which a guest imports via
 * `const { createGuest } = await import(boot.imports['@mithic/guest-runtime'])` — so the
 * module MUST keep its `export { createGuest, … }` (unlike the guest-IIFE `?bundle` form,
 * which drops export default and assigns globalThis.__mithic_default). Same esbuild machinery,
 * different `format`.
 */
export async function bundleGuestEsm(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

export function bundleGuestPlugin(): Plugin {
  return {
    name: 'mithic-lab-bundle-guest',
    enforce: 'pre',
    async resolveId(id, importer) {
      // Longest suffix first: `?bundle-esm` ends in `-esm`, so `?bundle` must not
      // match it. Delegate path resolution to Vite, then re-attach the marker so
      // `load` sees the absolute path. Relative ids resolve against the importer.
      for (const suf of [SUFFIX_ESM, SUFFIX]) {
        if (id.endsWith(suf)) {
          const bare = id.slice(0, -suf.length);
          const resolved = await this.resolve(bare, importer, { skipSelf: true });
          if (!resolved) return null;
          return resolved.id + suf;
        }
      }
      return null;
    },
    async load(id) {
      if (id.endsWith(SUFFIX_ESM)) {
        const entry = id.slice(0, -SUFFIX_ESM.length);
        this.addWatchFile(entry);
        return `export default ${JSON.stringify(await bundleGuestEsm(entry))};`;
      }
      if (id.endsWith(SUFFIX)) {
        const entry = id.slice(0, -SUFFIX.length);
        this.addWatchFile(entry);
        return `export default ${JSON.stringify(await bundleGuest(entry))};`;
      }
      return null;
    },
  };
}

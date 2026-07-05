/**
 * Vite plugin: `?bundle` / `?bundle-esm` — import a guest module's *self-contained
 * source text* for install into the VFS.
 *
 *   import imgresizeSrc from '../../../coreutils/src/commands/imgresize.ts?bundle';
 *   import guestRuntimeDep from '../../../guest-runtime/src/index.ts?bundle-esm';
 *
 * `?bundle` yields a single classic-script IIFE that inlines every dependency and ends
 * with `globalThis.__mithic_default = <module>.default;`. `?bundle-esm` yields a
 * self-contained ESM module with its NAMED exports preserved (used for G2 dependency
 * bytes — see `bundleGuestEsm`).
 *
 * HOW GUESTS LOAD (OF1/G2, spec 2026-07-04-esm-guest-loading-and-iframe-csp.md). The Lab
 * installs utilities into `/usr/bin` and the kernel runs them via exec-from-VFS: it reads
 * the file's bytes, strips the `#!/bin/node` shebang, and hands the SOURCE to the sandbox.
 * The Worker/iframe bootstrap mints an in-sandbox `blob:` module from that source and
 * `await import()`s it (NOT `(0,eval)`) — so a hand-authored ESM guest (`export default`)
 * runs straight from VFS bytes, and `@mithic/*` deps resolve via the host-curated
 * `boot.imports` map (in-sandbox `blob:` module URLs).
 *
 * `?bundle` (this IIFE form) is the FALLBACK for dep-heavy guests: esbuild drops the
 * guest's `export default`, so the imported blob module has NO `mod.default` — the footer's
 * top-level `globalThis.__mithic_default = …` runs on import, and the loader resolves the
 * entrypoint as `mod.default ?? globalThis.__mithic_default`, covering both the ESM and IIFE
 * forms with no content-sniffing. The U-phase utilities are `defineCommand`-wrapped ESM
 * modules with bare imports; this plugin produces the runnable install form at build time, so
 * the SAME modules the in-process command suite imports also install as exec-from-VFS-runnable
 * executables.
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
      // The two suffixes are non-overlapping ('...?bundle-esm' does not end with
      // '?bundle'), so match order is not load-bearing; the loop just keeps both
      // handlers together. Delegate path resolution to Vite, then re-attach the
      // marker so `load` sees the absolute path. Relative ids resolve against the importer.
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

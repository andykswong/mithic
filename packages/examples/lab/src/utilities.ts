/**
 * The installable utility registry: each entry is a command's *self-contained,
 * exec-from-VFS-runnable* source text (see {@link bundleGuestPlugin}) paired
 * with the {@link UtilityManifest} whose `capabilities` become the file's
 * `security.capability` xattr at install.
 *
 * Each utility's source is imported through the `?bundle` query, which routes the
 * coreutils command module through the Lab's Vite plugin and yields its
 * dependency-inlined IIFE source. We import the declared utilities EXPLICITLY
 * (rather than `import.meta.glob('commands/*.js')`) because Vite eagerly turns
 * every glob match into a build chunk — that would drag in the `*.test.ts`
 * siblings (some import `@mithic/kernel`, whose `node:*` imports break a browser
 * bundle) and 50+ unrelated coreutils. Explicit imports bundle exactly the
 * utilities the Lab installs; adding the N+1 utility is one import + one manifest.
 */
import copySource from '../../../coreutils/src/commands/copy.ts?bundle';
import csvcolsSource from '../../../coreutils/src/commands/csvcols.ts?bundle';
import imgresizeSource from '../../../coreutils/src/commands/imgresize.ts?bundle';
import imgconvertSource from '../../../coreutils/src/commands/imgconvert.ts?bundle';
import { UTILITY_MANIFESTS } from './manifests.ts';
import type { UtilityManifest } from './manifests.ts';

/** A command name → its bundled guest source (a classic-script IIFE). */
const SOURCES: Record<string, string> = {
  copy: copySource,
  csvcols: csvcolsSource,
  imgresize: imgresizeSource,
  imgconvert: imgconvertSource,
};

/** One installable utility: where its source lives and the grant it requests. */
export interface Utility {
  name: string;
  /** Self-contained guest source text (the installer prepends `#!/bin/node`). */
  source: string;
  manifest: UtilityManifest;
}

/**
 * The utilities the Lab installs into `/usr/bin` at boot: every command that has
 * both a bundled source and a declared manifest. The manifest's `capabilities`
 * become the file's `security.capability` xattr.
 */
export function labUtilities(): Utility[] {
  const utilities: Utility[] = [];
  for (const [name, manifest] of Object.entries(UTILITY_MANIFESTS)) {
    const source = SOURCES[name];
    if (source === undefined) {
      throw new Error(`lab: no bundled source for declared utility '${name}'`);
    }
    utilities.push({ name, source, manifest });
  }
  return utilities;
}

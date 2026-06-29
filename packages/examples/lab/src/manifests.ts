import type { AppManifest } from '@mithic/desktop';

/**
 * A utility's manifest is the same declarative shape as a desktop app's
 * `manifest.json` — `installUtility` flattens its `capabilities` block into the
 * file's `security.capability` xattr (the grant the kernel reads at exec, then
 * narrows against the parent). Aliased so the Lab is not coupled to the desktop
 * window-manager type by name.
 */
export type UtilityManifest = AppManifest;

/**
 * The capabilities each first-set utility requests. Each runs as a sandboxed
 * guest that only reads its input path and writes its output path — `fs`
 * read+write on the Lab's working tree, nothing else (no `net`, no `ipc`).
 */
export const UTILITY_MANIFESTS: Record<string, UtilityManifest> = {
  copy: {
    name: 'copy',
    capabilities: { fs: { paths: ['/in', '/out', '/work'], operations: ['read', 'write'] } },
  },
  csvcols: {
    name: 'csvcols',
    capabilities: { fs: { paths: ['/in', '/out', '/work'], operations: ['read', 'write'] } },
  },
  imgresize: {
    name: 'imgresize',
    capabilities: { fs: { paths: ['/in', '/out', '/work'], operations: ['read', 'write'] } },
  },
  imgconvert: {
    name: 'imgconvert',
    capabilities: { fs: { paths: ['/in', '/out', '/work'], operations: ['read', 'write'] } },
  },
};

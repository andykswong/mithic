import { installUtility } from '../install.ts';
import type { UtilityManifest } from '../manifests.ts';
import type { FileSystemProvider } from '@mithic/io/vfs';

/** Where the resize-convert workflow is installed (a bare name resolvable on $PATH). */
export const WORKFLOW_PATH = '/usr/bin/resize-convert';

/**
 * The workflow: `resize-convert WIDTH FORMAT IN OUT`. Chains two utility guests by
 * VFS path-args (bytes never traverse the shell — the path-arg convention). The
 * intermediate is a lossless PNG so the final re-encode to the output format is the
 * only lossy step. `set -euo pipefail` fails loud; the tmp is namespaced by PID to
 * avoid collisions across concurrent runs, and cleaned on exit.
 *
 * Note on `FORMAT` ($2): both `imgresize` and `imgconvert` derive the OUTPUT format
 * from the output path's EXTENSION (verified in `coreutils/src/commands/_image.ts`).
 * The caller (the app guest) therefore builds `OUT` with the chosen extension (e.g.
 * `/out/photo.webp`), so `imgconvert "$TMP" "$OUT"` produces the right format from
 * `$OUT` alone. `FORMAT` is bound for clarity/forward-compat and is intentionally not
 * passed to `imgconvert` (no flag consumes it) — do NOT try to pass it as an argv the
 * utilities don't accept. Keeping it in the signature documents intent and lets a
 * future format-specific flag (e.g. quality) attach without changing the call shape.
 */
export const RESIZE_CONVERT_SCRIPT = [
  '#!/bin/bash',
  'set -euo pipefail',
  'WIDTH="$1"; FORMAT="$2"; IN="$3"; OUT="$4"',  // FORMAT reserved; OUT extension drives the output format
  'TMP="/work/rc-$$.png"',
  'trap \'rm -f "$TMP"\' EXIT',
  'WIDTH="$WIDTH" imgresize "$IN" "$TMP"',
  'imgconvert "$TMP" "$OUT"',
  '',
].join('\n');

/** The workflow's grant: read/write the working tree + fork the two utility children. */
const WORKFLOW_MANIFEST: UtilityManifest = {
  name: 'resize-convert',
  capabilities: {
    fs: { paths: ['/in', '/out', '/work'], operations: ['read', 'write'] },
    process: { maxChildren: 16 },
  },
};

/** Install the resize-convert workflow into the VFS as an executable `#!/bin/bash` file. */
export async function installResizeConvertWorkflow(vfs: FileSystemProvider): Promise<void> {
  await installUtility(
    vfs,
    WORKFLOW_PATH,
    new TextEncoder().encode(RESIZE_CONVERT_SCRIPT),
    WORKFLOW_MANIFEST,
  );
}

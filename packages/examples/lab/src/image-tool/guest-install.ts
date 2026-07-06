import guestSource from './guest.ts?bundle';
import { installUtility } from '../install.ts';
import type { UtilityManifest } from '../manifests.ts';
import type { FileSystemProvider } from '@mithic/io/vfs';

/** Where the image-tool app guest is installed. */
export const IMAGE_TOOL_PATH = '/usr/bin/image-tool';

/**
 * The app guest's grant: read/write/exec the whole working tree, and fork children
 * (the workflow + its two utilities). The grant is `/` because the guest is the
 * ORCHESTRATOR: it spawns the `#!/bin/bash` `resize-convert` workflow, which the
 * kernel re-resolves to the `/bin/bash` interpreter whose own `security.capability`
 * xattr grants `fs:['/']`. A child's caps are narrowed against the parent, so a
 * narrower app-guest grant (e.g. `/in`,`/out`) would REJECT `/bin/bash`'s `/` grant
 * ("Capability exceeds parent grant") and the workflow could never launch. It holds
 * NO `net` — the guest cannot open its own connection; telemetry egress is host-side.
 */
const IMAGE_TOOL_MANIFEST: UtilityManifest = {
  name: 'image-tool',
  capabilities: {
    fs: { paths: ['/'], operations: ['read', 'write', 'execute'] },
    process: { maxChildren: 16 },
  },
};

/** Install the image-tool GUI app guest into the VFS as an executable. */
export async function installImageToolGuest(vfs: FileSystemProvider): Promise<void> {
  await installUtility(
    vfs,
    IMAGE_TOOL_PATH,
    new TextEncoder().encode(guestSource),
    IMAGE_TOOL_MANIFEST,
  );
}

import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import { encodeCapabilities, SECURITY_CAPABILITY_XATTR } from '@mithic/protocol';
import { manifestCapabilities } from '@mithic/desktop';
import type { UtilityManifest } from './manifests.js';

/** The shebang the kernel's exec-from-VFS path classifies as a `#!/bin/node` guest. */
const NODE_SHEBANG = '#!/bin/node\n';

/** Executable mode (rwxr-xr-x) — the execute bit is what the exec path checks. */
const EXEC_MODE = 0o755;

const WRITE_CHUNK = 65536;

/**
 * Install a utility executable into the VFS the Unix-honest way: write its
 * bytes, set the execute bit, and write the manifest's flattened `Capability[]`
 * into the file's `security.capability` xattr (the grant the kernel reads at
 * exec and narrows against the parent). The end user never runs `setcap` —
 * install is the step that turns a manifest into a file-borne grant (RFC §4.8).
 *
 * A `#!/bin/node` shebang is prepended when absent so the kernel dispatches the
 * bytes as a guest; an existing shebang is left untouched.
 */
export async function installUtility(
  vfs: FileSystemProvider,
  path: string,
  source: Uint8Array,
  manifest: UtilityManifest,
): Promise<void> {
  await ensureParentDirs(vfs, path);

  const bytes = hasShebang(source) ? source : prependShebang(source);

  const handle = (await vfs.open(path, { write: true, create: true, truncate: true })) as FileHandle;
  try {
    for (let off = 0; off < bytes.byteLength; off += WRITE_CHUNK) {
      const chunk = bytes.subarray(off, off + WRITE_CHUNK);
      await vfs.write(handle, chunk, off);
    }
  } finally {
    await Promise.resolve(vfs.close(handle)).catch(() => {});
  }

  await vfs.chmod(path, EXEC_MODE);
  await vfs.setxattr(path, SECURITY_CAPABILITY_XATTR, encodeCapabilities(manifestCapabilities(manifest)));
}

function hasShebang(source: Uint8Array): boolean {
  return source.byteLength >= 2 && source[0] === 0x23 /* # */ && source[1] === 0x21 /* ! */;
}

function prependShebang(source: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(NODE_SHEBANG);
  const out = new Uint8Array(head.byteLength + source.byteLength);
  out.set(head, 0);
  out.set(source, head.byteLength);
  return out;
}

async function ensureParentDirs(vfs: FileSystemProvider, path: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  segments.pop(); // drop the file name
  let dir = '';
  for (const seg of segments) {
    dir += `/${seg}`;
    try {
      await vfs.mkdir(dir);
    } catch {
      /* already exists */
    }
  }
}

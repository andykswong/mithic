import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';

/** Chunk size for the streamed read — matches the VFS read path elsewhere. */
const READ_CHUNK = 65536;

export interface DownloadOptions {
  /** MIME type stamped on the resulting `Blob` (e.g. `image/webp`). */
  type?: string;
}

/**
 * Read a VFS file out into a host `Blob` (RFC 0001 §4.4, G9). The file is read in
 * chunks at an advancing offset and the chunks are handed to the `Blob`
 * constructor — the `Blob` holds the parts without a second whole-file copy, so a
 * multi-MiB result stays bounded and never traverses the shell.
 */
export async function readVfsToBlob(
  vfs: FileSystemProvider,
  path: string,
  options: DownloadOptions = {},
): Promise<Blob> {
  const handle = (await vfs.open(path, { read: true })) as FileHandle;
  const parts: BlobPart[] = [];
  let offset = 0;
  try {
    for (;;) {
      const chunk = await vfs.read(handle, offset, READ_CHUNK);
      if (!chunk || chunk.byteLength === 0) break;
      // Copy out of the provider's buffer — the underlying ArrayBuffer may be
      // reused/detached on the next read, which the Blob must not alias.
      parts.push(new Uint8Array(chunk));
      offset += chunk.byteLength;
    }
  } finally {
    await Promise.resolve(vfs.close(handle)).catch(() => {});
  }
  return options.type ? new Blob(parts, { type: options.type }) : new Blob(parts);
}

/**
 * Hand a `Blob` to the browser as a download via a transient object-URL anchor
 * (RFC 0001 §4.4). The object URL is revoked after the click so it doesn't leak.
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

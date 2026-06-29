import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';

/** Chunk size for the streamed write — matches the VFS write path elsewhere. */
const WRITE_CHUNK = 65536;

export interface IngestOptions {
  /** Reject (and write nothing past the bound) if the source exceeds this many bytes. */
  maxBytes?: number;
}

/**
 * Stream a host `File` into a VFS path (RFC 0001 §4.4, G8). The bytes are read
 * from `file.stream()` and written to the VFS at an advancing offset in chunks —
 * never the whole buffer at once — so a multi-MiB drop stays bounded and the
 * bytes never traverse the string-typed shell (the path-arg convention). The
 * target is opened truncating so a re-ingest leaves no stale tail.
 *
 * @returns the number of bytes written.
 */
export async function ingestFile(
  vfs: FileSystemProvider,
  file: File,
  path: string,
  options: IngestOptions = {},
): Promise<number> {
  const { maxBytes } = options;
  if (maxBytes !== undefined && file.size > maxBytes) {
    throw new RangeError(`ingestFile: ${file.name} (${file.size} bytes) would exceed maxBytes=${maxBytes}`);
  }

  const handle = (await vfs.open(path, { write: true, create: true, truncate: true })) as FileHandle;
  let offset = 0;
  try {
    const reader = file.stream().getReader();
    let leftover: Uint8Array | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let buf = value as Uint8Array;
      if (leftover) {
        const merged = new Uint8Array(leftover.byteLength + buf.byteLength);
        merged.set(leftover, 0);
        merged.set(buf, leftover.byteLength);
        buf = merged;
        leftover = undefined;
      }
      let p = 0;
      // Write in whole WRITE_CHUNK slices; carry any remainder into the next read.
      while (buf.byteLength - p >= WRITE_CHUNK) {
        if (maxBytes !== undefined && offset + WRITE_CHUNK > maxBytes) {
          throw new RangeError(`ingestFile: stream would exceed maxBytes=${maxBytes}`);
        }
        await vfs.write(handle, buf.subarray(p, p + WRITE_CHUNK), offset);
        offset += WRITE_CHUNK;
        p += WRITE_CHUNK;
      }
      if (p < buf.byteLength) leftover = buf.subarray(p);
    }
    if (leftover && leftover.byteLength > 0) {
      if (maxBytes !== undefined && offset + leftover.byteLength > maxBytes) {
        throw new RangeError(`ingestFile: stream would exceed maxBytes=${maxBytes}`);
      }
      await vfs.write(handle, leftover, offset);
      offset += leftover.byteLength;
    }
  } finally {
    await Promise.resolve(vfs.close(handle)).catch(() => {});
  }
  return offset;
}

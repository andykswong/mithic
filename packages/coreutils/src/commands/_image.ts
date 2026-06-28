/**
 * Shared image-format helpers for the `OffscreenCanvas`-backed utilities
 * (`imgresize`, `imgconvert`): map an output path's extension to the MIME type
 * `canvas.convertToBlob({ type })` expects. An unknown extension returns
 * `undefined` so the caller can error rather than silently producing PNG.
 */
const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function mimeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return EXTENSION_MIME[path.slice(dot + 1).toLowerCase()];
}

/**
 * Wrap raw bytes in a `Blob`. Copies into a fresh `ArrayBuffer`-backed view so
 * the part is statically a `BlobPart` (a `Uint8Array<ArrayBufferLike>` straight
 * from a syscall may be over a `SharedArrayBuffer`, which `BlobPart` excludes).
 */
export function bytesToBlob(bytes: Uint8Array, type?: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return type === undefined ? new Blob([copy]) : new Blob([copy], { type });
}

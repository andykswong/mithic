/**
 * Task V5 — the Lab preview pane (RFC 0001 §4.5, G17 + D4).
 *
 * A result at a VFS path is read into a host-created `blob:` object URL and
 * rendered as an `<img>` through a {@link RemoteDomHost}. The host page's CSP
 * permits `blob:` (the sandbox iframe's does not, D4), and the Remote-DOM
 * allowlist already permits `img` + `src` — so this is the first place a `blob:`
 * preview is exercised end-to-end. The existing allowlist is reused unchanged.
 *
 * The preview is mounted via DomMutation records (createElement/appendChild/
 * setAttribute) exactly as a guest would, so it goes through the same sanitizer:
 * a `data:`/`javascript:`/`vbscript:` URL would be rejected, but `blob:` is not
 * on the blocklist and so paints.
 */
import type { RemoteDomHost } from '@mithic/kernel';
import type { FileSystemProvider } from '@mithic/io/vfs';
import { readVfsToBlob } from './download.ts';

/** Map an output path's extension to the MIME the `<img>`/`<video>` element needs. */
const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

function mimeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return EXTENSION_MIME[path.slice(dot + 1).toLowerCase()];
}

/** Node ids for the single mounted `<img>` (kept stable so a re-preview replaces it). */
const IMG_NODE_ID = 1;

/**
 * Read the file at `path` from `vfs`, mint a host `blob:` object URL for it, and
 * mount (or replace) a single `<img>` in the host's container via the
 * Remote-DOM sanitizer. Returns the `blob:` URL so the caller can
 * `URL.revokeObjectURL` it when the preview is torn down.
 */
export async function previewResult(
  host: RemoteDomHost,
  vfs: FileSystemProvider,
  path: string,
): Promise<string> {
  const blob = await readVfsToBlob(vfs, path, { type: mimeForPath(path) });
  const url = URL.createObjectURL(blob);

  // Replace any prior preview img (one pane = one image): drop the node, then
  // re-create it. removeChild is a no-op if the node was never created.
  host.applyMutations([{ type: 'removeChild', parentId: 0, childId: IMG_NODE_ID }]);
  host.applyMutations([
    { type: 'createElement', id: IMG_NODE_ID, tag: 'img' },
    { type: 'setAttribute', id: IMG_NODE_ID, name: 'src', value: url },
    { type: 'appendChild', parentId: 0, childId: IMG_NODE_ID },
  ]);

  return url;
}

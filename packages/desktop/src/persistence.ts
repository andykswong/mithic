import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import type { Rect } from './types.ts';

/** Where the WM stores per-app window geometry. */
export const LAYOUT_PATH = '/.mithic-desktop/layout.json';

/** Saved geometry keyed by app name (last-window-wins for singletons). */
export type SavedLayout = Record<string, Rect>;

/** Read the saved layout; returns `{}` if absent or unparseable. */
export async function loadLayout(vfs: FileSystemProvider): Promise<SavedLayout> {
  let handle: FileHandle;
  try {
    handle = (await vfs.open(LAYOUT_PATH, { read: true })) as FileHandle;
  } catch {
    return {};
  }
  try {
    const chunks: Uint8Array[] = [];
    let off = 0;
    for (;;) {
      const c = await vfs.read(handle, off, 65536);
      if (!c || c.byteLength === 0) break;
      chunks.push(new Uint8Array(c));
      off += c.byteLength;
    }
    const text = new TextDecoder().decode(concat(chunks));
    const parsed = JSON.parse(text) as unknown;
    return isLayout(parsed) ? parsed : {};
  } catch {
    return {};
  } finally {
    await Promise.resolve(vfs.close(handle)).catch(() => {});
  }
}

/** Persist the layout, creating parent dir + file as needed. */
export async function saveLayout(vfs: FileSystemProvider, layout: SavedLayout): Promise<void> {
  const dir = LAYOUT_PATH.slice(0, LAYOUT_PATH.lastIndexOf('/'));
  try { await vfs.mkdir(dir); } catch { /* exists */ }
  const handle = (await vfs.open(LAYOUT_PATH, { write: true, create: true, truncate: true })) as FileHandle;
  try {
    await vfs.write(handle, new TextEncoder().encode(JSON.stringify(layout)), 0);
  } finally {
    await Promise.resolve(vfs.close(handle)).catch(() => {});
  }
}

function isLayout(x: unknown): x is SavedLayout {
  if (typeof x !== 'object' || x === null) return false;
  for (const v of Object.values(x)) {
    if (typeof v !== 'object' || v === null) return false;
    const r = v as Record<string, unknown>;
    if (['x', 'y', 'w', 'h'].some((k) => typeof r[k] !== 'number')) return false;
  }
  return true;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0; for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

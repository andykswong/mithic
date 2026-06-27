/**
 * Real-OPFS persistence test (audit §11).
 *
 * The existing layout-persistence suite (persistence.test.ts) round-trips against an
 * in-memory MemoryFsProvider, which proves the serialization logic but NOT that geometry
 * actually SURVIVES a reload — a MemoryFs is recreated empty every time. A browser reload
 * destroys all in-page JS state but keeps the Origin Private File System; the desktop's
 * value proposition (windows reopen where you left them) depends on that.
 *
 * Here we exercise the real `OPFSProvider` against Chromium's `navigator.storage` (which
 * works headless under Playwright). The "reload" is simulated by constructing a FRESH
 * router + FRESH OPFSProvider over the SAME persistent backing directory — new instances,
 * same on-disk store — and asserting the data is still there.
 *
 * Each top-level test uses a unique backing-dir name (unique per run) so concurrent runs
 * and repeats don't collide, matching io/src/vfs/providers/opfs.browser.test.ts.
 */
import { expect, test } from 'vitest';
import { FileSystemRouter } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import { OPFSProvider } from '@mithic/io/vfs/providers/opfs';
import { saveLayout, loadLayout } from './persistence.ts';

/**
 * Build a router whose `/` is backed by a real OPFS subdirectory named `dirName`.
 * Calling this twice with the same `dirName` yields two independent provider/router
 * instances over the SAME persistent backing store — i.e. a simulated reload.
 */
async function routerOver(dirName: string): Promise<FileSystemProvider> {
  const opfsRoot = await navigator.storage.getDirectory();
  const sub = await opfsRoot.getDirectoryHandle(dirName, { create: true });
  const storage = { getDirectory: async () => sub };
  const provider = new OPFSProvider(storage);
  const router = new FileSystemRouter();
  await router.mount('/', provider); // mount() drives provider.init()
  return router;
}

test('layout geometry round-trips across a simulated reload (fresh OPFSProvider, same backing dir)', async () => {
  const dir = `desktop-layout-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // First "session": save a layout.
  const first = await routerOver(dir);
  const layout = {
    editor: { x: 17, y: 23, w: 642, h: 418 },
    files: { x: 5, y: 9, w: 561, h: 421 },
  };
  await saveLayout(first, layout);

  // Simulated reload: brand-new router + brand-new OPFSProvider over the SAME OPFS dir.
  const second = await routerOver(dir);
  const restored = await loadLayout(second);

  expect(restored).toEqual(layout);
});

test('a file written via the VFS survives re-open with a fresh OPFSProvider over the same dir', async () => {
  const dir = `desktop-file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = '/persisted/data.txt';
  const payload = 'window-geometry survives a reload\n';

  // Write via the first router.
  const first = await routerOver(dir);
  await first.mkdir('/persisted');
  const wh = (await first.open(path, { write: true, create: true, truncate: true })) as FileHandle;
  await first.write(wh, new TextEncoder().encode(payload), 0);
  await first.close(wh);

  // Simulated reload: fresh provider over the same backing dir, then read it back.
  const second = await routerOver(dir);
  const rh = (await second.open(path, { read: true })) as FileHandle;
  const chunks: Uint8Array[] = [];
  let off = 0;
  for (;;) {
    const c = await second.read(rh, off, 65536);
    if (!c || c.byteLength === 0) break;
    chunks.push(new Uint8Array(c));
    off += c.byteLength;
  }
  await second.close(rh);
  let total = 0; for (const c of chunks) total += c.byteLength;
  const buf = new Uint8Array(total); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; }

  expect(new TextDecoder().decode(buf)).toBe(payload);
});

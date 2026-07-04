import { describe, expect, test } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { loadLayout, saveLayout, LAYOUT_PATH, loadPins, savePins, PINS_PATH } from './persistence.ts';

async function freshVfs() {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  return vfs;
}

describe('layout persistence', () => {
  test('loadLayout returns {} when no file exists', async () => {
    const vfs = await freshVfs();
    expect(await loadLayout(vfs)).toEqual({});
  });
  test('saveLayout then loadLayout round-trips geometry by app name', async () => {
    const vfs = await freshVfs();
    const layout = { editor: { x: 10, y: 20, w: 600, h: 400 }, files: { x: 0, y: 0, w: 800, h: 500 } };
    await saveLayout(vfs, layout);
    expect(await loadLayout(vfs)).toEqual(layout);
  });
  test('loadLayout tolerates a corrupt file (returns {})', async () => {
    const vfs = await freshVfs();
    // saveLayout creates the parent dir; overwrite the file with non-JSON bytes.
    await saveLayout(vfs, { a: { x: 1, y: 1, w: 1, h: 1 } });
    const h = await vfs.open(LAYOUT_PATH, { write: true, create: true, truncate: true });
    await vfs.write(h, new TextEncoder().encode('not json{'), 0);
    await vfs.close(h);
    expect(await loadLayout(vfs)).toEqual({});
  });
  test('saveLayout overwrites a prior layout', async () => {
    const vfs = await freshVfs();
    await saveLayout(vfs, { a: { x: 1, y: 1, w: 1, h: 1 } });
    await saveLayout(vfs, { b: { x: 2, y: 2, w: 2, h: 2 } });
    expect(await loadLayout(vfs)).toEqual({ b: { x: 2, y: 2, w: 2, h: 2 } });
  });
});

describe('pins persistence', () => {
  test('loadPins returns [] when no file exists', async () => {
    const vfs = await freshVfs();
    expect(await loadPins(vfs)).toEqual([]);
  });
  test('savePins then loadPins round-trips the pinned-app list', async () => {
    const vfs = await freshVfs();
    await savePins(vfs, ['terminal', 'files']);
    expect(await loadPins(vfs)).toEqual(['terminal', 'files']);
    expect(PINS_PATH).toBe('/.mithic-desktop/pins.json');
  });
  test('loadPins tolerates a corrupt / wrong-shaped file (returns [])', async () => {
    const vfs = await freshVfs();
    await savePins(vfs, ['a']);
    const h = await vfs.open(PINS_PATH, { write: true, create: true, truncate: true });
    await vfs.write(h, new TextEncoder().encode('{"not":"an array"}'), 0);
    await vfs.close(h);
    expect(await loadPins(vfs)).toEqual([]);
  });
});

import { expect, test } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { FileHandle } from '@mithic/io/vfs';
import { WindowManager } from './window-manager.ts';
import { AppRegistry } from './app-registry.ts';
import { loadLayout, LAYOUT_PATH } from './persistence.ts';

// Minimal fake kernel (mirrors window-manager.browser.test.ts): the persistence
// tests use tier-1 apps so spawn/wait/kill are never exercised.
function fakeKernel() {
  let nextPid = 100;
  return {
    async spawn() { return { pid: nextPid++ }; },
    async wait() { return new Promise<{ code: number }>(() => {}); },
    kill() {},
  };
}

async function freshStorage() {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  return vfs;
}

function setupDesktop() {
  const desktop = document.createElement('div');
  desktop.style.cssText = 'position:relative;width:1000px;height:700px;';
  document.body.appendChild(desktop);
  return desktop;
}

function registerApp(apps: AppRegistry) {
  apps.register({ name: 'a', title: 'A', defaultSize: [200, 150], mount: () => {} });
}

/** Drive a real pointer drag of the window titlebar by (dx,dy). */
function dragTitlebar(win: { frame: HTMLElement }, dx: number, dy: number): void {
  const titlebar = win.frame.querySelector('[data-role="titlebar"]') as HTMLElement;
  const startX = 100, startY = 60;
  titlebar.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, pointerId: 1, bubbles: true }));
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: startX + dx, clientY: startY + dy, pointerId: 1, bubbles: true }));
  document.dispatchEvent(new PointerEvent('pointerup', { clientX: startX + dx, clientY: startY + dy, pointerId: 1, bubbles: true }));
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('drag-end persists window geometry to storage (keyed by app name)', async () => {
  const desktop = setupDesktop();
  const storage = await freshStorage();
  const apps = new AppRegistry();
  registerApp(apps);
  const wm = new WindowManager({ desktop, kernel: fakeKernel() as any, apps, storage });

  const win = await wm.open('a');
  const before = { ...win.geometry };
  dragTitlebar(win, 120, 80);
  expect(win.geometry.x).toBe(before.x + 120);
  expect(win.geometry.y).toBe(before.y + 80);

  // The drag-end persist is fire-and-forget; give the microtasks a tick.
  await tick();
  const saved = await loadLayout(storage);
  expect(saved.a).toEqual(win.geometry);

  wm.dispose(); desktop.remove();
});

test('a second WindowManager with the same storage restores the saved geometry (not cascade)', async () => {
  const desktop = setupDesktop();
  const storage = await freshStorage();

  // First WM: open + drag + close, which persists the moved geometry.
  const apps1 = new AppRegistry();
  registerApp(apps1);
  const wm1 = new WindowManager({ desktop, kernel: fakeKernel() as any, apps: apps1, storage });
  const win1 = await wm1.open('a');
  dragTitlebar(win1, 200, 150);
  const movedGeometry = { ...win1.geometry };
  wm1.close(win1.id);
  await tick();
  wm1.dispose();

  // Sanity: the cascade placement for the FIRST window is NOT the moved geometry,
  // so a passing restore can't be a coincidence.
  expect(movedGeometry.x).not.toBe(24);

  // Second WM: same storage, same app. It must restore, not cascade.
  const apps2 = new AppRegistry();
  registerApp(apps2);
  const wm2 = new WindowManager({ desktop, kernel: fakeKernel() as any, apps: apps2, storage });
  const win2 = await wm2.open('a');
  expect(win2.geometry).toEqual(movedGeometry);

  wm2.dispose(); desktop.remove();
});

test('close() persists the current geometry to the layout file', async () => {
  const desktop = setupDesktop();
  const storage = await freshStorage();
  const apps = new AppRegistry();
  registerApp(apps);
  const wm = new WindowManager({ desktop, kernel: fakeKernel() as any, apps, storage });

  const win = await wm.open('a');
  const geom = { ...win.geometry };
  wm.close(win.id);
  await tick();

  // Assert the on-disk file content directly (saveLayout actually ran).
  const h = (await storage.open(LAYOUT_PATH, { read: true })) as FileHandle;
  const c = await storage.read(h, 0, 65536);
  await storage.close(h);
  const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(c!)));
  expect(parsed.a).toEqual(geom);

  wm.dispose(); desktop.remove();
});

test('without a storage option the window cascades and nothing is persisted', async () => {
  const desktop = setupDesktop();
  const apps = new AppRegistry();
  registerApp(apps);
  const wm = new WindowManager({ desktop, kernel: fakeKernel() as any, apps });

  const win = await wm.open('a');
  // First-window cascade origin is (24,24) per geometry.ts.
  expect(win.geometry.x).toBe(24);
  expect(win.geometry.y).toBe(24);

  // Dragging + closing must not throw with no storage.
  dragTitlebar(win, 50, 50);
  expect(() => wm.close(win.id)).not.toThrow();

  wm.dispose(); desktop.remove();
});

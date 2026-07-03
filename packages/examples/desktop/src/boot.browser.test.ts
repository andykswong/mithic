import { expect, test } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { createTaskbar } from '@mithic/desktop';
import { bootDesktop } from './boot.ts';

function surface() {
  const desktop = document.createElement('div');
  desktop.style.cssText = 'position:relative;width:1024px;height:700px;';
  const taskbar = document.createElement('div');
  document.body.append(desktop, taskbar);
  return { desktop, taskbar };
}

test('WM renders running chips into a taskbar runningRegion, leaving app-menu/pinned intact', async () => {
  const desktop = document.createElement('div');
  desktop.style.cssText = 'position:relative;width:1024px;height:700px;';
  const taskbarHost = document.createElement('div');
  document.body.append(desktop, taskbarHost);

  const bar = createTaskbar(document);
  taskbarHost.appendChild(bar.root);
  const pin = document.createElement('button');
  pin.dataset.role = 'pin';
  bar.pinnedRegion.appendChild(pin);

  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const { wm } = await bootDesktop({ desktop, taskbar: bar.runningRegion, vfs });

  await wm.open('terminal');
  expect(bar.runningRegion.querySelectorAll('[data-role="taskbar-item"]').length).toBe(1);
  // The app-menu button and the pinned region survived the WM render.
  expect(bar.appMenuButton.isConnected).toBe(true);
  expect(bar.pinnedRegion.querySelector('[data-role="pin"]')).not.toBeNull();

  wm.dispose(); desktop.remove(); taskbarHost.remove();
});

test('app-menu button toggles the app drawer; launching from it opens a window', async () => {
  const { main } = await import('./main.ts');
  const desktop = Object.assign(document.createElement('div'), { id: 'desktop' });
  desktop.style.cssText = 'position:relative;width:1024px;height:700px;';
  const taskbar = Object.assign(document.createElement('div'), { id: 'taskbar' });
  document.body.append(desktop, taskbar);

  await main();
  const appMenu = taskbar.querySelector('[data-role="app-menu"]') as HTMLButtonElement;
  expect(appMenu).not.toBeNull();
  appMenu.click(); // opens the drawer
  const drawer = desktop.querySelector('[data-role="app-drawer"]') as HTMLElement;
  expect(drawer.style.display).toBe('flex');

  (drawer.querySelector('[data-app="files"]') as HTMLElement).click();
  for (let i = 0; i < 50 && desktop.querySelectorAll('[data-role="window"]').length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const titles = [...desktop.querySelectorAll('[data-role="title"]')].map((t) => t.textContent);
  expect(titles.some((t) => t?.includes('Files'))).toBe(true);

  desktop.remove(); taskbar.remove();
});

test('opens a terminal window and a tier-1 editor window', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider({ files: { '/notes.txt': 'hi\n' } }));
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  await wm.open('terminal');
  const editorWin = await wm.open('editor', { argv: ['/notes.txt'] });

  const frames = desktop.querySelectorAll('[data-role="window"]');
  expect(frames.length).toBe(2);
  // Editor textarea is present and loaded. Scope the lookup to the editor window's
  // content — the terminal's xterm also renders a (helper) <textarea>, so a
  // desktop-wide `querySelector('textarea')` would match the terminal's first.
  const ta = editorWin.content.querySelector('textarea') as HTMLTextAreaElement;
  expect(ta).not.toBeNull();
  // Allow the editor's async VFS-backed load to settle (poll rather than a fixed
  // sleep — the open/read/close chain can take a few event-loop turns).
  for (let i = 0; i < 50 && ta.value !== 'hi\n'; i++) await new Promise((r) => setTimeout(r, 10));
  expect(ta.value).toBe('hi\n');

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('opens the image-viewer as a sandboxed (tier-2) window and reports ready', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  const win = await wm.open('image-viewer');
  // A sandboxed iframe is mounted INSIDE the window content (not document.body).
  const iframe = win.content.querySelector('iframe');
  expect(iframe).not.toBeNull();
  expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
  expect(win.pid).toBeGreaterThan(0);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('image-viewer window size comes from its manifest defaultSize (800x600)', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  const win = await wm.open('image-viewer');
  // The 1024x700 desktop is large enough that clampToBounds leaves 800x600 intact,
  // proving the geometry came from the manifest (not the old hard-coded 480x360).
  expect(win.geometry.w).toBe(800);
  expect(win.geometry.h).toBe(600);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('file manager "Open With" launches the associated editor window', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider({ files: { '/a.txt': 'content\n' } }));
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  await wm.open('files');
  // Wait for the directory listing to render (VFS-backed navigate()).
  let fileRow: HTMLElement | null = null;
  for (let i = 0; i < 50 && !(fileRow = desktop.querySelector('[data-name="a.txt"]')); i++) await new Promise((r) => setTimeout(r, 10));
  expect(fileRow).not.toBeNull();
  fileRow!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  // Wait for the editor window to open via "Open With".
  for (let i = 0; i < 50 && desktop.querySelectorAll('[data-role="window"]').length < 2; i++) await new Promise((r) => setTimeout(r, 10));

  // A second window (the editor) opened for the file.
  const frames = desktop.querySelectorAll('[data-role="window"]');
  expect(frames.length).toBe(2);
  const editorTitle = [...desktop.querySelectorAll('[data-role="title"]')].some((t) => t.textContent?.includes('a.txt'));
  expect(editorTitle).toBe(true);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('closing a tier-2 window removes its frame', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  const win = await wm.open('image-viewer');
  expect(desktop.querySelectorAll('[data-role="window"]').length).toBe(1);
  wm.close(win.id);
  expect(desktop.querySelectorAll('[data-role="window"]').length).toBe(0);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

// --- Image-viewer guest lifecycle coverage ---
//
// The image-viewer guest (image-viewer-guest.ts) renders a drop-zone, emits 'ready'
// then 'img-rendered:<url>' over stdout on drop. Because it runs in an OPAQUE-ORIGIN
// sandboxed iframe (sandbox="allow-scripts", no allow-same-origin), the host CANNOT
// reach into the guest's document to fire a synthetic `drop` or inspect <img>/<div>.
// We therefore assert only what IS observable across that boundary: the sandboxed
// iframe mounts inside win.content (never document.body), carries a process pid, and
// the close() SIGTERM lifecycle detaches the iframe from the live DOM.

test('image-viewer guest iframe mounts inside win.content with opaque-origin sandbox and a live pid', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  const win = await wm.open('image-viewer');

  const iframe = win.content.querySelector('iframe') as HTMLIFrameElement;
  expect(iframe).not.toBeNull();
  // The guest iframe lives in the window content, NOT loose on document.body.
  expect(win.content.contains(iframe)).toBe(true);
  // Opaque-origin guard at the integration level: allow-scripts only, never same-origin.
  const sandbox = iframe.getAttribute('sandbox');
  expect(sandbox).toBe('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  // A real kernel process was spawned for the GUI guest.
  expect(win.pid).toBeGreaterThan(0);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('closing the image-viewer (SIGTERM) detaches its guest iframe from the live DOM', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  const win = await wm.open('image-viewer');
  const iframe = win.content.querySelector('iframe') as HTMLIFrameElement;
  expect(iframe).not.toBeNull();
  expect(document.body.contains(iframe)).toBe(true);

  wm.close(win.id);

  // The whole window frame is gone and its guest iframe is no longer in the document.
  expect(desktop.querySelectorAll('[data-role="window"]').length).toBe(0);
  expect(document.body.contains(iframe)).toBe(false);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

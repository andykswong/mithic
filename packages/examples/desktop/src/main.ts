import { bootDesktop } from './boot.ts';
import { FileSystemRouter, DeviceFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider } from '@mithic/io/vfs';
import { createTaskbar, createAppDrawer, renderPinned, loadPins, savePins } from '@mithic/desktop';

/** Try OPFS at `/` (persistent); fall back to the default seeded MemoryFs. */
async function persistentVfs(): Promise<FileSystemProvider | undefined> {
  try {
    if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return undefined;
    const { OPFSProvider } = await import('@mithic/io/vfs/providers/opfs');
    const router = new FileSystemRouter();
    const opfs = new OPFSProvider();
    await router.mount('/', opfs);
    await router.mount('/dev', new DeviceFsProvider());
    return router;
  } catch { return undefined; }
}

async function main(): Promise<void> {
  const desktop = document.getElementById('desktop');
  const taskbarHost = document.getElementById('taskbar');
  if (!desktop || !taskbarHost) return;

  // Build the centered taskbar shell FIRST; the WM projects running windows into
  // its runningRegion (an owned child), so it never clobbers the app-menu/pinned regions.
  const bar = createTaskbar(document);
  taskbarHost.appendChild(bar.root);

  const vfs = await persistentVfs();
  const { wm, apps, vfs: activeVfs } = await bootDesktop({ desktop, taskbar: bar.runningRegion, vfs });

  // Pinned shelf (persisted). Seed a default set on first boot.
  let pins = await loadPins(activeVfs);
  if (pins.length === 0) pins = ['terminal', 'files', 'editor'];
  const paint = (): void => renderPinned(document, bar.pinnedRegion, {
    pins,
    apps: apps.list(),
    onLaunch: (n) => void wm.open(n),
    onUnpin: (n) => { pins = pins.filter((p) => p !== n); void savePins(activeVfs, pins); paint(); },
  });
  const togglePin = (name: string): void => {
    pins = pins.includes(name) ? pins.filter((p) => p !== name) : [...pins, name];
    void savePins(activeVfs, pins);
    paint();
  };
  paint();

  // App drawer, toggled by the app-menu button. Hidden apps (displayMode 'hidden')
  // are not launchable from the grid.
  const drawer = createAppDrawer(document, {
    apps: () => apps.list().filter((a) => a.displayMode !== 'hidden'),
    onLaunch: (n) => void wm.open(n),
    onTogglePin: togglePin,
    isPinned: (name) => pins.includes(name),
  });
  desktop.appendChild(drawer.root);
  bar.appMenuButton.addEventListener('click', () => drawer.toggle());

  // Open a terminal by default.
  await wm.open('terminal');
}

if (typeof document !== 'undefined' && document.getElementById('desktop')) {
  void main();
}

export { main };

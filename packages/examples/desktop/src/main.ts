import { bootDesktop } from './boot.ts';
import { FileSystemRouter, DeviceFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider } from '@mithic/io/vfs';

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
  const taskbar = document.getElementById('taskbar');
  if (!desktop || !taskbar) return;

  const vfs = await persistentVfs();
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  // Launcher: a button per app, prepended into the taskbar (before window items).
  const launcher = document.createElement('div');
  launcher.style.cssText = 'display:flex;gap:4px;margin-right:8px;border-right:1px solid #313244;padding-right:8px;';
  for (const name of ['terminal', 'files', 'editor', 'image-viewer']) {
    const b = document.createElement('button');
    b.textContent = name;
    b.style.cssText = 'font:12px sans-serif;cursor:pointer;';
    b.addEventListener('click', () => { void wm.open(name); });
    launcher.appendChild(b);
  }
  taskbar.prepend(launcher);

  // Open a terminal by default.
  void wm.open('terminal');
}

if (typeof document !== 'undefined' && document.getElementById('desktop')) {
  void main();
}

export { main };

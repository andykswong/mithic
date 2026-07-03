import { Kernel } from '@mithic/kernel';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider, DeviceFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import { WindowManager, AppRegistry, appDescriptorFromManifest, mountTextEditor, mountFileManager } from '@mithic/desktop';
import type { AppManifest, EditorFs, FileManagerFs, Entry, WindowContext } from '@mithic/desktop';
import imageViewerManifest from '@mithic/example-image-viewer/manifest' with { type: 'json' };
import { createCommandSuite } from './commands.ts';
import { mountTerminal } from './terminal-app.ts';
import { IMAGE_VIEWER_GUEST } from './image-viewer-guest.ts';

const SEED: Record<string, string> = {
  '/welcome.txt': 'Welcome to Mithic OS!\nEverything here runs sandboxed in your browser.\n',
  '/notes.txt': 'edit me\n',
  '/tmp/.keep': '',
};

export interface DesktopHandle {
  wm: WindowManager;
  kernel: Kernel;
  vfs: FileSystemProvider;
  apps: AppRegistry;
}

/** Build VFS-backed adapters for the editor + file-manager apps. */
function editorFs(vfs: FileSystemProvider): EditorFs {
  const dec = new TextDecoder(); const enc = new TextEncoder();
  return {
    async readFile(path) {
      const h = (await vfs.open(path, { read: true })) as FileHandle;
      const chunks: Uint8Array[] = []; let off = 0;
      for (;;) { const c = await vfs.read(h, off, 65536); if (!c || c.byteLength === 0) break; chunks.push(new Uint8Array(c)); off += c.byteLength; }
      await vfs.close(h); let t = 0; for (const c of chunks) t += c.byteLength; const b = new Uint8Array(t); let o = 0; for (const c of chunks) { b.set(c, o); o += c.byteLength; } return dec.decode(b);
    },
    async writeFile(path, text) {
      const h = (await vfs.open(path, { write: true, create: true, truncate: true })) as FileHandle;
      await vfs.write(h, enc.encode(text), 0); await vfs.close(h);
    },
  };
}

function fileManagerFs(vfs: FileSystemProvider): FileManagerFs {
  return {
    async list(path) {
      const entries = await vfs.readdir(path);
      return entries.map((e): Entry => ({ name: e.name, kind: e.type === 'directory' ? 'directory' : 'file' }));
    },
    async mkdir(path) { await vfs.mkdir(path); },
    async createFile(path) { const h = (await vfs.open(path, { write: true, create: true, truncate: true })) as FileHandle; await vfs.close(h); },
    async remove(path) { try { await vfs.unlink(path); } catch { await vfs.rmdir(path); } },
    async rename(from, to) { await vfs.rename(from, to); },
    async copy(from, to) {
      const s = await vfs.stat(from);
      if (s.type === 'directory') {
        await vfs.mkdir(to);
        for (const child of await vfs.readdir(from)) {
          await this.copy(`${from}/${child.name}`, `${to}/${child.name}`);
        }
      } else {
        const rh = (await vfs.open(from, { read: true })) as FileHandle;
        const chunks: Uint8Array[] = []; let off = 0;
        for (;;) { const c = await vfs.read(rh, off, 65536); if (!c || c.byteLength === 0) break; chunks.push(new Uint8Array(c)); off += c.byteLength; }
        await vfs.close(rh);
        let total = 0; for (const c of chunks) total += c.byteLength;
        const buf = new Uint8Array(total); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
        const wh = (await vfs.open(to, { write: true, create: true, truncate: true })) as FileHandle;
        await vfs.write(wh, buf, 0); await vfs.close(wh);
      }
    },
  };
}

export interface BootOptions {
  desktop: HTMLElement;
  taskbar?: HTMLElement;
  /** Extra VFS to use instead of the default seeded MemoryFs (e.g. OPFS at /). */
  vfs?: FileSystemProvider;
}

export async function bootDesktop(opts: BootOptions): Promise<DesktopHandle> {
  const suite = createCommandSuite();

  let vfs: FileSystemProvider;
  if (opts.vfs) {
    vfs = opts.vfs;
  } else {
    const router = new FileSystemRouter();
    await router.mount('/', new MemoryFsProvider({ files: SEED }));
    await router.mount('/dev', new DeviceFsProvider());
    vfs = router;
  }

  const kernel = new Kernel({
    runtime: new IframeRuntime({ container: opts.desktop }),
    vfs,
    resolveCommand: (name) => suite.resolve(name),
    launcher: suite.launcher,
  });

  const apps = new AppRegistry();
  const efs = editorFs(vfs);
  const ffs = fileManagerFs(vfs);

  const wm = new WindowManager({ desktop: opts.desktop, taskbar: opts.taskbar, kernel, apps, storage: vfs });

  apps.register({ name: 'terminal', title: 'Terminal', defaultSize: [640, 400], icon: '🖥️',
    mount: (ctx: WindowContext) => { mountTerminal(ctx, { kernel, vfs, suite }); } });

  apps.register({ name: 'editor', title: 'Editor', defaultSize: [600, 420], icon: '📝',
    mount: (ctx: WindowContext, argv) => { mountTextEditor(ctx, argv.length ? argv : ['/notes.txt'], efs); } });

  apps.register({ name: 'files', title: 'Files', defaultSize: [560, 420], icon: '📁', singleton: true,
    mount: (ctx: WindowContext) => {
      mountFileManager(ctx, {
        fs: ffs,
        locations: [
          { label: 'My files', path: '/', icon: '🏠' },
          { label: 'Temp', path: '/tmp', icon: '🗂️' },
          { label: 'Devices', path: '/dev', icon: '🔌' },
        ],
        onOpen: (path) => {
          const app = apps.resolveForFile(path) ?? apps.get('editor')!;
          void wm.open(app.name, { argv: [path] });
        },
      });
    } });

  // The image-viewer's display geometry + capabilities come from ITS manifest.json
  // (display.defaultSize [800,600], mode 'window', fs:/tmp). The host supplies only
  // the code hook (the inline guest) + an icon.
  apps.register(appDescriptorFromManifest(imageViewerManifest as unknown as AppManifest, {
    entry: IMAGE_VIEWER_GUEST, icon: '🖼️',
  }));

  apps.associate('txt', 'editor');
  apps.associate('json', 'editor');
  apps.associate('md', 'editor');
  apps.associate('png', 'image-viewer');
  apps.associate('jpg', 'image-viewer');
  apps.associate('jpeg', 'image-viewer');
  apps.associate('gif', 'image-viewer');

  return { wm, kernel, vfs, apps };
}

import { describe, expect, test } from 'vitest';
import { AppRegistry, appDescriptorFromManifest } from './app-registry.ts';
import type { AppManifest } from './app-registry.ts';
import type { AppDescriptor } from './types.ts';

const editor: AppDescriptor = { name: 'editor', title: 'Editor', defaultSize: [600, 400], mount: () => {} };
const viewer: AppDescriptor = { name: 'viewer', title: 'Viewer', defaultSize: [800, 600], entry: 'code;' };

describe('AppRegistry', () => {
  test('register + get + list', () => {
    const r = new AppRegistry();
    r.register(editor);
    r.register(viewer);
    expect(r.get('editor')).toBe(editor);
    expect(r.list().map((a) => a.name).sort()).toEqual(['editor', 'viewer']);
  });
  test('get returns undefined for unknown app', () => {
    expect(new AppRegistry().get('nope')).toBeUndefined();
  });
  test('rejects a descriptor with neither mount nor entry', () => {
    const r = new AppRegistry();
    expect(() => r.register({ name: 'bad', title: 'B', defaultSize: [1, 1] }))
      .toThrow(/must declare exactly one of `mount` or `entry`/);
  });
  test('rejects a descriptor with BOTH mount and entry', () => {
    const r = new AppRegistry();
    expect(() => r.register({ name: 'bad', title: 'B', defaultSize: [1, 1], mount: () => {}, entry: 'x' }))
      .toThrow(/must declare exactly one of `mount` or `entry`/);
  });
  test('rejects duplicate registration', () => {
    const r = new AppRegistry();
    r.register(editor);
    expect(() => r.register(editor)).toThrow(/already registered: editor/);
  });
  test('resolveForFile maps an extension to a registered app name', () => {
    const r = new AppRegistry();
    r.register(editor);
    r.register(viewer);
    r.associate('txt', 'editor');
    r.associate('png', 'viewer');
    expect(r.resolveForFile('/a/b/notes.txt')?.name).toBe('editor');
    expect(r.resolveForFile('/x/pic.PNG')?.name).toBe('viewer'); // case-insensitive
    expect(r.resolveForFile('/x/unknown.zzz')).toBeUndefined();
    expect(r.resolveForFile('/x/noext')).toBeUndefined();
  });
});

describe('appDescriptorFromManifest', () => {
  test('reads display.defaultSize + mode + capabilities + title/icon + entry', () => {
    const manifest: AppManifest = {
      name: 'image-viewer',
      title: 'Image Viewer',
      display: { mode: 'window', defaultSize: [480, 360] },
      capabilities: { fs: { paths: ['/tmp'], operations: ['read', 'write'] } },
    };
    const d = appDescriptorFromManifest(manifest, { entry: 'CODE;', icon: '🖼️' });
    expect(d.name).toBe('image-viewer');
    expect(d.title).toBe('Image Viewer');
    expect(d.icon).toBe('🖼️');
    expect(d.defaultSize).toEqual([480, 360]);
    expect(d.displayMode).toBe('window');
    expect(d.capabilities).toEqual([{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }]);
    expect(d.entry).toBe('CODE;');
    expect(d.mount).toBeUndefined();
  });

  test('defaults size + mode + title when manifest omits display/title; carries a mount hook', () => {
    const mount = (): void => {};
    const d = appDescriptorFromManifest({ name: 'x' }, { mount });
    expect(d.name).toBe('x');
    expect(d.title).toBe('x'); // title falls back to name
    expect(d.defaultSize).toEqual([640, 480]);
    expect(d.displayMode).toBe('window');
    expect(d.capabilities).toEqual([]);
    expect(d.mount).toBe(mount);
    expect(d.entry).toBeUndefined();
  });

  test('honors a hidden displayMode declared in the manifest', () => {
    const d = appDescriptorFromManifest(
      { name: 'daemon', display: { mode: 'hidden' } },
      { entry: 'CODE;' },
    );
    expect(d.displayMode).toBe('hidden');
  });

  test('converts every manifest capability shape to a Capability[] entry', () => {
    const manifest: AppManifest = {
      name: 'kitchen-sink',
      capabilities: {
        fs: { paths: ['/a', '/b'], operations: ['read', 'write', 'execute'] },
        net: { origins: ['https://example.com'] },
        ipc: { channels: ['chan-1'] },
        process: { maxChildren: 3 },
        env: true,
      },
    };
    const d = appDescriptorFromManifest(manifest, { entry: 'CODE;' });
    expect(d.capabilities).toEqual([
      { type: 'fs', paths: ['/a', '/b'], operations: ['read', 'write', 'execute'] },
      { type: 'net', origins: ['https://example.com'] },
      { type: 'ipc', channels: ['chan-1'] },
      { type: 'process', maxChildren: 3 },
      { type: 'env' },
    ]);
  });

  test('omits a capability whose manifest key is absent (no spurious entries)', () => {
    const d = appDescriptorFromManifest(
      { name: 'net-only', capabilities: { net: { origins: ['https://x.test'] } } },
      { entry: 'CODE;' },
    );
    expect(d.capabilities).toEqual([{ type: 'net', origins: ['https://x.test'] }]);
  });

  test('icon from extras takes precedence over a manifest icon', () => {
    const d = appDescriptorFromManifest(
      { name: 'x', icon: '📦' },
      { entry: 'CODE;', icon: '🖼️' },
    );
    expect(d.icon).toBe('🖼️');
  });

  test('falls back to the manifest icon when extras omits one', () => {
    const d = appDescriptorFromManifest({ name: 'x', icon: '📦' }, { entry: 'CODE;' });
    expect(d.icon).toBe('📦');
  });

  test('produces a descriptor the AppRegistry accepts (exactly one of entry/mount)', () => {
    const r = new AppRegistry();
    r.register(appDescriptorFromManifest({ name: 'app1' }, { entry: 'CODE;' }));
    r.register(appDescriptorFromManifest({ name: 'app2' }, { mount: () => {} }));
    expect(r.list().map((a) => a.name).sort()).toEqual(['app1', 'app2']);
  });
});

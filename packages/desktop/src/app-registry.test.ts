import { describe, expect, test } from 'vitest';
import { AppRegistry } from './app-registry.ts';
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

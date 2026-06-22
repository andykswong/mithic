import { describe, expect, test, vi } from 'vitest';
import { createFileManagerModel, type FileManagerFs, type Entry } from './file-manager.ts';

function fakeFs(tree: Record<string, Entry[]>): FileManagerFs {
  return {
    async list(path) { return tree[path] ? [...tree[path]] : []; },
    async mkdir(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'directory' }); },
    async createFile(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'file' }); },
    async remove(path) { const p = parent(path); tree[p] = (tree[p] ?? []).filter((e) => e.name !== base(path)); },
    async rename(from, to) { const p = parent(from); const e = (tree[p] ?? []).find((x) => x.name === base(from)); if (e) e.name = base(to); },
  };
}
const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

describe('file manager model', () => {
  test('lists the cwd sorted dirs-first then name', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [
      { name: 'b.txt', kind: 'file' }, { name: 'docs', kind: 'directory' }, { name: 'a.txt', kind: 'file' },
    ] }), onOpen: () => {} });
    await m.navigate('/');
    expect(m.entries.map((e) => e.name)).toEqual(['docs', 'a.txt', 'b.txt']);
    expect(m.cwd).toBe('/');
  });
  test('navigate into a subdir and back via up()', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [{ name: 'docs', kind: 'directory' }], '/docs': [{ name: 'x.txt', kind: 'file' }] }), onOpen: () => {} });
    await m.navigate('/');
    await m.enter('docs');
    expect(m.cwd).toBe('/docs');
    expect(m.entries.map((e) => e.name)).toEqual(['x.txt']);
    await m.up();
    expect(m.cwd).toBe('/');
  });
  test('opening a file delegates to onOpen with the absolute path', async () => {
    const onOpen = vi.fn();
    const m = createFileManagerModel({ fs: fakeFs({ '/': [{ name: 'a.txt', kind: 'file' }] }), onOpen });
    await m.navigate('/');
    await m.open('a.txt');
    expect(onOpen).toHaveBeenCalledWith('/a.txt');
  });
  test('newFolder / newFile / remove / rename mutate and refresh', async () => {
    const fs = fakeFs({ '/': [] });
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/');
    await m.newFolder('sub'); expect(m.entries.some((e) => e.name === 'sub' && e.kind === 'directory')).toBe(true);
    await m.newFile('f.txt'); expect(m.entries.some((e) => e.name === 'f.txt')).toBe(true);
    await m.rename('f.txt', 'g.txt'); expect(m.entries.some((e) => e.name === 'g.txt')).toBe(true);
    await m.remove('g.txt'); expect(m.entries.some((e) => e.name === 'g.txt')).toBe(false);
  });
  test('up() at root is a no-op', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [] }), onOpen: () => {} });
    await m.navigate('/');
    await m.up();
    expect(m.cwd).toBe('/');
  });
});

import { describe, expect, test, vi } from 'vitest';
import { createFileManagerModel, type FileManagerFs, type Entry } from './file-manager.ts';

function fakeFs(tree: Record<string, Entry[]>): FileManagerFs {
  return {
    async list(path) { return tree[path] ? [...tree[path]] : []; },
    async mkdir(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'directory' }); },
    async createFile(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'file' }); },
    async remove(path) { const p = parent(path); tree[p] = (tree[p] ?? []).filter((e) => e.name !== base(path)); },
    async rename(from, to) { const p = parent(from); const e = (tree[p] ?? []).find((x) => x.name === base(from)); if (e) e.name = base(to); },
    async copy(from, to) {
      const e = (tree[parent(from)] ?? []).find((x) => x.name === base(from));
      if (e) (tree[parent(to)] ??= []).push({ ...e, name: base(to) });
    },
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

  test('setSort reorders entries (size desc) while keeping directories grouped first', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [
      { name: 'b.txt', kind: 'file', size: 10 },
      { name: 'a.txt', kind: 'file', size: 30 },
      { name: 'dir', kind: 'directory' },
    ] }), onOpen: () => {} });
    await m.navigate('/');
    m.setSort('size', 'desc');
    expect(m.entries.map((e) => e.name)).toEqual(['dir', 'a.txt', 'b.txt']); // dirs first, then size desc
    m.setSort('name', 'asc');
    expect(m.entries.map((e) => e.name)).toEqual(['dir', 'a.txt', 'b.txt']);
  });

  test('setQuery filters entries by case-insensitive substring', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [
      { name: 'Invoice.pdf', kind: 'file' },
      { name: 'notes.txt', kind: 'file' },
      { name: 'invoices', kind: 'directory' },
    ] }), onOpen: () => {} });
    await m.navigate('/');
    m.setQuery('invo');
    expect(m.entries.map((e) => e.name).sort()).toEqual(['Invoice.pdf', 'invoices']);
    m.setQuery('');
    expect(m.entries.length).toBe(3);
  });
});

describe('clipboard', () => {
  test('copy + paste duplicates a file into the current dir (de-duped name)', async () => {
    const calls: string[] = [];
    const fs: FileManagerFs = {
      async list(p) { return p === '/' ? [{ name: 'a.txt', kind: 'file' }] : []; },
      async mkdir() {}, async createFile() {}, async remove() {}, async rename() {},
      async copy(from, to) { calls.push(`copy ${from} -> ${to}`); },
    };
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/');
    m.copy('a.txt');
    await m.paste();
    // 'a.txt' exists → paste writes 'a (1).txt' (name de-dup).
    expect(calls).toEqual(['copy /a.txt -> /a (1).txt']);
  });

  test('cut + paste moves via rename and clears the clipboard', async () => {
    const calls: string[] = [];
    const fs: FileManagerFs = {
      async list(p) { return p === '/sub' ? [] : [{ name: 'a.txt', kind: 'file' }, { name: 'sub', kind: 'directory' }]; },
      async mkdir() {}, async createFile() {}, async remove() {},
      async rename(from, to) { calls.push(`rename ${from} -> ${to}`); },
      async copy() {},
    };
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/');
    m.cut('a.txt');
    m.select('sub');
    await m.pasteInto('/sub');
    expect(calls).toEqual(['rename /a.txt -> /sub/a.txt']);
    expect(m.clipboard).toBeNull(); // cut consumed
  });
});

describe('breadcrumb segments', () => {
  test('root has a single root segment', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [] }), onOpen: () => {} });
    await m.navigate('/');
    expect(m.segments).toEqual([{ label: '/', path: '/' }]);
  });
  test('nested cwd yields cumulative segment paths', async () => {
    const m = createFileManagerModel({
      fs: fakeFs({ '/': [{ name: 'foo', kind: 'directory' }], '/foo': [{ name: 'bar', kind: 'directory' }], '/foo/bar': [] }),
      onOpen: () => {},
    });
    await m.navigate('/foo/bar');
    expect(m.segments).toEqual([
      { label: '/', path: '/' },
      { label: 'foo', path: '/foo' },
      { label: 'bar', path: '/foo/bar' },
    ]);
  });
  test('navigating to a segment path changes cwd', async () => {
    const m = createFileManagerModel({
      fs: fakeFs({ '/': [{ name: 'foo', kind: 'directory' }], '/foo': [{ name: 'bar', kind: 'directory' }], '/foo/bar': [] }),
      onOpen: () => {},
    });
    await m.navigate('/foo/bar');
    await m.navigate(m.segments[1].path);
    expect(m.cwd).toBe('/foo');
  });
});

describe('back / forward history', () => {
  function nav3() {
    return createFileManagerModel({
      fs: fakeFs({ '/': [{ name: 'a', kind: 'directory' }], '/a': [{ name: 'b', kind: 'directory' }], '/a/b': [] }),
      onOpen: () => {},
    });
  }
  test('canBack/canForward start false at the first navigation', async () => {
    const m = nav3();
    await m.navigate('/');
    expect(m.canBack).toBe(false);
    expect(m.canForward).toBe(false);
  });
  test('back returns to previous path and enables forward', async () => {
    const m = nav3();
    await m.navigate('/');
    await m.navigate('/a');
    expect(m.canBack).toBe(true);
    await m.back();
    expect(m.cwd).toBe('/');
    expect(m.canForward).toBe(true);
    await m.forward();
    expect(m.cwd).toBe('/a');
  });
  test('enter() and up() participate in history', async () => {
    const m = nav3();
    await m.navigate('/');
    await m.enter('a');
    await m.enter('b');
    expect(m.cwd).toBe('/a/b');
    await m.back();
    expect(m.cwd).toBe('/a');
    await m.back();
    expect(m.cwd).toBe('/');
  });
  test('navigating after going back truncates the forward stack (browser semantics)', async () => {
    const m = nav3();
    await m.navigate('/');
    await m.navigate('/a');
    await m.navigate('/a/b');
    await m.back();          // back to /a
    expect(m.canForward).toBe(true);
    await m.navigate('/');   // new nav truncates forward
    expect(m.cwd).toBe('/');
    expect(m.canForward).toBe(false);
  });
  test('back at the start and forward at the end are no-ops', async () => {
    const m = nav3();
    await m.navigate('/');
    await m.back();
    expect(m.cwd).toBe('/');
    await m.forward();
    expect(m.cwd).toBe('/');
  });
  test('re-navigating to the current path does not grow history', async () => {
    const m = nav3();
    await m.navigate('/');
    await m.navigate('/');
    expect(m.canBack).toBe(false);
  });
});

describe('selection', () => {
  test('select highlights an entry and clearSelection resets it', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [{ name: 'a.txt', kind: 'file' }] }), onOpen: () => {} });
    await m.navigate('/');
    expect(m.selected).toBeNull();
    m.select('a.txt');
    expect(m.selected).toBe('a.txt');
    m.clearSelection();
    expect(m.selected).toBeNull();
  });
  test('navigation clears the current selection', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [{ name: 'docs', kind: 'directory' }], '/docs': [] }), onOpen: () => {} });
    await m.navigate('/');
    m.select('docs');
    await m.enter('docs');
    expect(m.selected).toBeNull();
  });
});

describe('move', () => {
  test('move(name, destDir) renames using correct absolute src/dest paths', async () => {
    const rename = vi.fn(async () => {});
    const fs: FileManagerFs = {
      list: async () => [{ name: 'a.txt', kind: 'file' }, { name: 'docs', kind: 'directory' }],
      mkdir: async () => {}, createFile: async () => {}, remove: async () => {}, rename, copy: async () => {},
    };
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/');
    await m.move('a.txt', '/docs');
    expect(rename).toHaveBeenCalledWith('/a.txt', '/docs/a.txt');
  });
  test('move from a nested cwd builds the source from cwd', async () => {
    const rename = vi.fn(async () => {});
    const fs: FileManagerFs = {
      list: async () => [{ name: 'sub', kind: 'directory' }, { name: 'f.txt', kind: 'file' }],
      mkdir: async () => {}, createFile: async () => {}, remove: async () => {}, rename, copy: async () => {},
    };
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/work');
    await m.move('f.txt', '/work/sub');
    expect(rename).toHaveBeenCalledWith('/work/f.txt', '/work/sub/f.txt');
  });
  test('moving onto the root dir produces /name', async () => {
    const rename = vi.fn(async () => {});
    const fs: FileManagerFs = {
      list: async () => [{ name: 'f.txt', kind: 'file' }],
      mkdir: async () => {}, createFile: async () => {}, remove: async () => {}, rename, copy: async () => {},
    };
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/work');
    await m.move('f.txt', '/');
    expect(rename).toHaveBeenCalledWith('/work/f.txt', '/f.txt');
  });
  test('moving onto the same directory is a no-op (no rename)', async () => {
    const rename = vi.fn(async () => {});
    const fs: FileManagerFs = {
      list: async () => [{ name: 'f.txt', kind: 'file' }],
      mkdir: async () => {}, createFile: async () => {}, remove: async () => {}, rename, copy: async () => {},
    };
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/work');
    await m.move('f.txt', '/work');
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('tree children', () => {
  test('listChildren returns dirs-first sorted entries for a path', async () => {
    const m = createFileManagerModel({
      fs: fakeFs({ '/': [], '/foo': [{ name: 'z.txt', kind: 'file' }, { name: 'sub', kind: 'directory' }] }),
      onOpen: () => {},
    });
    await m.navigate('/');
    const kids = await m.listChildren('/foo');
    expect(kids.map((e) => e.name)).toEqual(['sub', 'z.txt']);
  });
});

describe('error handling', () => {
  test('refresh surfaces an empty list and an error flag when fs.list rejects', async () => {
    const fs: FileManagerFs = {
      list: async () => { throw new Error('EACCES'); },
      mkdir: async () => {}, createFile: async () => {}, remove: async () => {}, rename: async () => {}, copy: async () => {},
    };
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await expect(m.navigate('/secret')).resolves.toBeUndefined();
    expect(m.entries).toEqual([]);
    expect(m.error).toBe(true);
    expect(m.cwd).toBe('/secret');
  });
  test('a successful navigation clears a prior error flag', async () => {
    let fail = true;
    const fs: FileManagerFs = {
      list: async () => { if (fail) throw new Error('EACCES'); return [{ name: 'ok.txt', kind: 'file' }]; },
      mkdir: async () => {}, createFile: async () => {}, remove: async () => {}, rename: async () => {}, copy: async () => {},
    };
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/secret');
    expect(m.error).toBe(true);
    fail = false;
    await m.navigate('/open');
    expect(m.error).toBe(false);
    expect(m.entries.map((e) => e.name)).toEqual(['ok.txt']);
  });
  test('navigating to an empty dir yields an empty entry list without error', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [{ name: 'empty', kind: 'directory' }], '/empty': [] }), onOpen: () => {} });
    await m.navigate('/');
    await m.enter('empty');
    expect(m.entries).toEqual([]);
    expect(m.error).toBe(false);
  });
});

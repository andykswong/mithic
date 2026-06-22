import { expect, test } from 'vitest';
import { renderFileManager, type FileManagerFs, type Entry } from './file-manager.ts';

function fakeFs(tree: Record<string, Entry[]>): FileManagerFs {
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return {
    async list(path) { return tree[path] ? [...tree[path]] : []; },
    async mkdir(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'directory' }); },
    async createFile(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'file' }); },
    async remove(path) { const p = parent(path); tree[p] = (tree[p] ?? []).filter((e) => e.name !== base(path)); },
    async rename(from, to) { const p = parent(from); const e = (tree[p] ?? []).find((x) => x.name === base(from)); if (e) e.name = base(to); },
  };
}

test('file manager renders rows and opens a file on dblclick', async () => {
  const opened: string[] = [];
  const h = renderFileManager(document, {
    fs: fakeFs({ '/': [{ name: 'docs', kind: 'directory' }, { name: 'a.txt', kind: 'file' }] }),
    onOpen: (p) => opened.push(p),
  });
  document.body.appendChild(h.root);
  await h.ready;

  const rows = h.root.querySelectorAll('[data-name]');
  expect(rows.length).toBe(2);
  // dirs first
  expect((rows[0] as HTMLElement).dataset.name).toBe('docs');

  const fileRow = h.root.querySelector('[data-name="a.txt"]') as HTMLElement;
  fileRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await Promise.resolve();
  expect(opened).toEqual(['/a.txt']);

  h.root.remove();
});

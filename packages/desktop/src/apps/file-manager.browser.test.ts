import { expect, test, vi } from 'vitest';
import { renderFileManager, type FileManagerFs, type Entry } from './file-manager.ts';

function fakeFs(tree: Record<string, Entry[]>): FileManagerFs {
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return {
    async list(path) { return tree[path] ? [...tree[path]] : []; },
    async mkdir(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'directory' }); },
    async createFile(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'file' }); },
    async remove(path) { const p = parent(path); tree[p] = (tree[p] ?? []).filter((e) => e.name !== base(path)); },
    async rename(from, to) {
      const fp = parent(from); const e = (tree[fp] ?? []).find((x) => x.name === base(from));
      if (!e) return;
      tree[fp] = (tree[fp] ?? []).filter((x) => x.name !== base(from));
      (tree[parent(to)] ??= []).push({ ...e, name: base(to) });
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

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
  expect((rows[0] as HTMLElement).dataset.name).toBe('docs');

  const fileRow = h.root.querySelector('[data-name="a.txt"]') as HTMLElement;
  fileRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await tick();
  expect(opened).toEqual(['/a.txt']);

  h.root.remove();
});

test('renders both a tree pane and a list pane', async () => {
  const h = renderFileManager(document, {
    fs: fakeFs({ '/': [{ name: 'docs', kind: 'directory' }] }),
    onOpen: () => {},
  });
  document.body.appendChild(h.root);
  await h.ready;

  expect(h.root.querySelector('[data-pane="tree"]')).not.toBeNull();
  expect(h.root.querySelector('[data-pane="list"]')).not.toBeNull();
  // tree shows the root + its directory children (files excluded from tree)
  expect(h.root.querySelector('[data-tree-path="/docs"]')).not.toBeNull();

  h.root.remove();
});

test('clicking a tree folder navigates the list pane', async () => {
  const h = renderFileManager(document, {
    fs: fakeFs({ '/': [{ name: 'docs', kind: 'directory' }], '/docs': [{ name: 'inner.txt', kind: 'file' }] }),
    onOpen: () => {},
  });
  document.body.appendChild(h.root);
  await h.ready;

  const node = h.root.querySelector('[data-tree-path="/docs"]') as HTMLElement;
  node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  expect(h.model.cwd).toBe('/docs');
  expect(h.root.querySelector('[data-name="inner.txt"]')).not.toBeNull();

  h.root.remove();
});

test('clicking a tree disclosure lazily loads children', async () => {
  const fs = fakeFs({ '/': [{ name: 'docs', kind: 'directory' }], '/docs': [{ name: 'sub', kind: 'directory' }] });
  const listSpy = vi.spyOn(fs, 'list');
  const h = renderFileManager(document, { fs, onOpen: () => {} });
  document.body.appendChild(h.root);
  await h.ready;

  // /docs/sub not in the tree until /docs is expanded
  expect(h.root.querySelector('[data-tree-path="/docs/sub"]')).toBeNull();
  const disclosure = h.root.querySelector('[data-tree-toggle="/docs"]') as HTMLElement;
  disclosure.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  expect(listSpy).toHaveBeenCalledWith('/docs');
  expect(h.root.querySelector('[data-tree-path="/docs/sub"]')).not.toBeNull();

  h.root.remove();
});

test('clickable breadcrumb segments navigate to ancestors', async () => {
  const h = renderFileManager(document, {
    fs: fakeFs({ '/': [{ name: 'foo', kind: 'directory' }], '/foo': [{ name: 'bar', kind: 'directory' }], '/foo/bar': [] }),
    onOpen: () => {},
  });
  document.body.appendChild(h.root);
  await h.ready;

  // navigate down through the UI (double-click rows) so the crumb redraws
  (h.root.querySelector('[data-name="foo"]') as HTMLElement)
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await tick();
  (h.root.querySelector('[data-name="bar"]') as HTMLElement)
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await tick();
  expect(h.model.cwd).toBe('/foo/bar');

  const segs = h.root.querySelectorAll('[data-crumb]');
  expect(segs.length).toBe(3); // / foo bar
  const fooSeg = h.root.querySelector('[data-crumb="/foo"]') as HTMLElement;
  fooSeg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  expect(h.model.cwd).toBe('/foo');

  h.root.remove();
});

test('Back and Forward toolbar buttons drive history', async () => {
  const h = renderFileManager(document, {
    fs: fakeFs({ '/': [{ name: 'a', kind: 'directory' }], '/a': [] }),
    onOpen: () => {},
  });
  document.body.appendChild(h.root);
  await h.ready;

  const backBtn = h.root.querySelector('[data-action="back"]') as HTMLButtonElement;
  const fwdBtn = h.root.querySelector('[data-action="forward"]') as HTMLButtonElement;
  expect(backBtn).not.toBeNull();
  expect(fwdBtn).not.toBeNull();
  // at root: nothing to go back/forward to
  expect(backBtn.disabled).toBe(true);
  expect(fwdBtn.disabled).toBe(true);

  // navigate down through the UI so the toolbar's disabled state stays accurate
  (h.root.querySelector('[data-name="a"]') as HTMLElement)
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await tick();
  expect(h.model.cwd).toBe('/a');
  expect(backBtn.disabled).toBe(false);

  backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  expect(h.model.cwd).toBe('/');
  expect(fwdBtn.disabled).toBe(false);

  fwdBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  expect(h.model.cwd).toBe('/a');

  h.root.remove();
});

test('clicking a row selects and highlights it', async () => {
  const h = renderFileManager(document, {
    fs: fakeFs({ '/': [{ name: 'a.txt', kind: 'file' }, { name: 'b.txt', kind: 'file' }] }),
    onOpen: () => {},
  });
  document.body.appendChild(h.root);
  await h.ready;

  const rowA = h.root.querySelector('[data-name="a.txt"]') as HTMLElement;
  rowA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  expect(h.model.selected).toBe('a.txt');
  expect(rowA.dataset.selected).toBe('true');

  h.root.remove();
});

test('right-click a row opens a real context menu (not a prompt) with Open/Rename/Delete', async () => {
  const promptSpy = vi.spyOn(globalThis, 'prompt').mockReturnValue(null);
  const opened: string[] = [];
  const h = renderFileManager(document, {
    fs: fakeFs({ '/': [{ name: 'a.txt', kind: 'file' }] }),
    onOpen: (p) => opened.push(p),
  });
  document.body.appendChild(h.root);
  await h.ready;

  const row = h.root.querySelector('[data-name="a.txt"]') as HTMLElement;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
  await tick();

  const menu = h.root.querySelector('[data-menu]') as HTMLElement;
  expect(menu).not.toBeNull();
  // the contextmenu must NOT have asked the user to type an action
  expect(promptSpy).not.toHaveBeenCalled();

  const labels = Array.from(menu.querySelectorAll('[data-menu-item]')).map((el) => el.textContent);
  expect(labels).toEqual(expect.arrayContaining(['Open', 'Open With…', 'Rename', 'Delete']));

  // Clicking Open invokes onOpen with the absolute path
  const openItem = menu.querySelector('[data-menu-item="open"]') as HTMLElement;
  openItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  expect(opened).toEqual(['/a.txt']);
  // menu dismissed after action
  expect(h.root.querySelector('[data-menu]')).toBeNull();

  promptSpy.mockRestore();
  h.root.remove();
});

test('right-click empty space opens a New Folder / New File menu', async () => {
  const h = renderFileManager(document, { fs: fakeFs({ '/': [] }), onOpen: () => {} });
  document.body.appendChild(h.root);
  await h.ready;

  const listPane = h.root.querySelector('[data-pane="list"]') as HTMLElement;
  listPane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
  await tick();

  const menu = h.root.querySelector('[data-menu]') as HTMLElement;
  expect(menu).not.toBeNull();
  const labels = Array.from(menu.querySelectorAll('[data-menu-item]')).map((el) => el.textContent);
  expect(labels).toEqual(expect.arrayContaining(['New Folder', 'New File']));

  h.root.remove();
});

test('context menu dismisses on outside click and Escape', async () => {
  const h = renderFileManager(document, { fs: fakeFs({ '/': [{ name: 'a.txt', kind: 'file' }] }), onOpen: () => {} });
  document.body.appendChild(h.root);
  await h.ready;

  const row = h.root.querySelector('[data-name="a.txt"]') as HTMLElement;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  await tick();
  expect(h.root.querySelector('[data-menu]')).not.toBeNull();
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await tick();
  expect(h.root.querySelector('[data-menu]')).toBeNull();

  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  await tick();
  expect(h.root.querySelector('[data-menu]')).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  expect(h.root.querySelector('[data-menu]')).toBeNull();

  h.root.remove();
});

test('dragging a file row onto a folder row moves it (fs.rename + entry relocates)', async () => {
  const fs = fakeFs({ '/': [{ name: 'docs', kind: 'directory' }, { name: 'a.txt', kind: 'file' }], '/docs': [] });
  const renameSpy = vi.spyOn(fs, 'rename');
  const h = renderFileManager(document, { fs, onOpen: () => {} });
  document.body.appendChild(h.root);
  await h.ready;

  const fileRow = h.root.querySelector('[data-name="a.txt"]') as HTMLElement;
  const folderRow = h.root.querySelector('[data-name="docs"]') as HTMLElement;
  expect(fileRow.draggable).toBe(true);

  const dt = new DataTransfer();
  fileRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  folderRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, cancelable: true }));
  folderRow.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  await tick();

  expect(renameSpy).toHaveBeenCalledWith('/a.txt', '/docs/a.txt');
  // a.txt gone from the root list, moved under /docs
  expect(h.root.querySelector('[data-name="a.txt"]')).toBeNull();

  h.root.remove();
});

test('dropping a file onto a tree folder moves it there', async () => {
  const fs = fakeFs({ '/': [{ name: 'docs', kind: 'directory' }, { name: 'a.txt', kind: 'file' }], '/docs': [] });
  const renameSpy = vi.spyOn(fs, 'rename');
  const h = renderFileManager(document, { fs, onOpen: () => {} });
  document.body.appendChild(h.root);
  await h.ready;

  const fileRow = h.root.querySelector('[data-name="a.txt"]') as HTMLElement;
  const treeNode = h.root.querySelector('[data-tree-path="/docs"]') as HTMLElement;

  const dt = new DataTransfer();
  fileRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  treeNode.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, cancelable: true }));
  treeNode.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  await tick();

  expect(renameSpy).toHaveBeenCalledWith('/a.txt', '/docs/a.txt');
  h.root.remove();
});

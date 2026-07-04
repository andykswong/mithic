import type { WindowContext } from '../types.ts';

export interface Entry { name: string; kind: 'file' | 'directory'; size?: number; }

/** A breadcrumb path segment: a display label and the absolute path it points to. */
export interface PathSegment { label: string; path: string; }

/** The file ops the manager needs (absolute paths). */
export interface FileManagerFs {
  list(path: string): Promise<Entry[]>;
  mkdir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Copy a file OR directory (recursively) from `from` to `to`. */
  copy(from: string, to: string): Promise<void>;
}

export interface FileLocation { label: string; path: string; icon?: string; }

export interface FileManagerDeps {
  fs: FileManagerFs;
  /** Launch the app associated with a file (WM wires this to "Open With"). */
  onOpen(path: string): void;
  /** When provided, a ChromeOS-style "locations" sidebar replaces the directory tree. */
  locations?: FileLocation[];
}

export type SortKey = 'name' | 'size' | 'type';
export type SortDir = 'asc' | 'desc';

export interface Clipboard { op: 'copy' | 'cut'; path: string; name: string; }

export interface FileManagerModel {
  readonly cwd: string;
  readonly entries: Entry[];
  /** True when the last refresh failed (e.g. fs.list rejected). */
  readonly error: boolean;
  /** Cumulative breadcrumb segments from root to cwd. */
  readonly segments: PathSegment[];
  /** Currently selected entry name in the cwd, or null. */
  readonly selected: string | null;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly sortKey: SortKey;
  readonly sortDir: SortDir;
  readonly query: string;
  readonly clipboard: Clipboard | null;
  setSort(key: SortKey, dir?: SortDir): void;
  setQuery(q: string): void;
  copy(name: string): void;
  cut(name: string): void;
  /** Paste into the current dir (de-duping the name if it collides). */
  paste(): Promise<void>;
  /** Paste into an explicit dir (e.g. a selected subfolder). */
  pasteInto(destDir: string): Promise<void>;
  navigate(path: string): Promise<void>;
  enter(name: string): Promise<void>;
  up(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  open(name: string): Promise<void>;
  newFolder(name: string): Promise<void>;
  newFile(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Move `name` (in cwd) into `destDir` via fs.rename. No-op if already there. */
  move(name: string, destDir: string): Promise<void>;
  /** Lazily list a directory's children (dirs-first sorted) — for the tree pane. */
  listChildren(path: string): Promise<Entry[]>;
  select(name: string): void;
  clearSelection(): void;
}

const join = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (p: string): string => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/');

/** Sort by key+dir but always group directories first (case-insensitive tiebreak on name). */
function sortView(entries: Entry[], key: SortKey, dir: SortDir): Entry[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1; // dirs first, regardless of dir
    let cmp = 0;
    if (key === 'size') cmp = (a.size ?? 0) - (b.size ?? 0);
    else if (key === 'type') cmp = extOf2(a.name).localeCompare(extOf2(b.name));
    if (cmp === 0) cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return cmp * sign;
  });
}
function extOf2(name: string): string { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }

/**
 * If `name` collides in `existing`, insert " (1)", " (2)", … before the extension.
 * `force` de-dupes even on the first attempt (used when a cut lands in a dir that
 * already holds a same-named entry). Returns the first free name.
 */
function dedupeName(name: string, existing: Set<string>, force = false): string {
  if (!force && !existing.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** Build cumulative breadcrumb segments from an absolute path. */
function pathSegments(p: string): PathSegment[] {
  const segs: PathSegment[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of p.split('/').filter(Boolean)) {
    acc += `/${part}`;
    segs.push({ label: part, path: acc });
  }
  return segs;
}

/** The headless model — navigation + actions, no DOM. Node-testable. */
export function createFileManagerModel(deps: FileManagerDeps): FileManagerModel {
  let cwd = '/';
  let rawEntries: Entry[] = [];
  let error = false;
  let selected: string | null = null;
  let sortKey: SortKey = 'name';
  let sortDir: SortDir = 'asc';
  let query = '';
  let clipboard: Clipboard | null = null;
  const history: string[] = [];
  let histIndex = -1;

  const refresh = async (): Promise<void> => {
    try {
      rawEntries = await deps.fs.list(cwd);
      error = false;
    } catch {
      rawEntries = [];
      error = true;
    }
  };

  const view = (): Entry[] => {
    const q = query.trim().toLowerCase();
    const filtered = q ? rawEntries.filter((e) => e.name.toLowerCase().includes(q)) : rawEntries;
    return sortView(filtered, sortKey, sortDir);
  };

  /** Set cwd, push onto history (truncating any forward stack), refresh. */
  const go = async (path: string): Promise<void> => {
    if (path !== cwd || histIndex < 0) {
      cwd = path;
      history.splice(histIndex + 1);
      history.push(path);
      histIndex = history.length - 1;
    }
    selected = null;
    query = ''; // a search filter is scoped to the folder it was typed in
    await refresh();
  };

  const model: FileManagerModel = {
    get cwd() { return cwd; },
    get entries() { return view(); },
    get error() { return error; },
    get segments() { return pathSegments(cwd); },
    get selected() { return selected; },
    get canBack() { return histIndex > 0; },
    get canForward() { return histIndex < history.length - 1; },
    get sortKey() { return sortKey; },
    get sortDir() { return sortDir; },
    get query() { return query; },
    get clipboard() { return clipboard; },
    setSort(key, d) { sortKey = key; if (d) sortDir = d; else if (key === sortKey) sortDir = sortDir === 'asc' ? 'desc' : 'asc'; },
    setQuery(q) { query = q; selected = null; }, // a filter change can hide the selected row
    copy(name) { clipboard = { op: 'copy', path: join(cwd, name), name }; },
    cut(name) { clipboard = { op: 'cut', path: join(cwd, name), name }; },
    async paste() { await model.pasteInto(cwd); },
    async pasteInto(destDir) {
      if (!clipboard) return;
      const existing = new Set((await deps.fs.list(destDir)).map((e) => e.name));
      const dest = join(destDir, dedupeName(clipboard.name, existing, clipboard.op === 'cut' && destDir === parentOf(clipboard.path)));
      if (clipboard.op === 'copy') await deps.fs.copy(clipboard.path, dest);
      else await deps.fs.rename(clipboard.path, dest);
      if (clipboard.op === 'cut') clipboard = null; // move consumes the clipboard
      await refresh();
    },
    async navigate(path) { await go(path); },
    async enter(name) { await go(join(cwd, name)); },
    async up() { await go(parentOf(cwd)); },
    async back() {
      if (histIndex <= 0) return;
      histIndex -= 1;
      cwd = history[histIndex];
      selected = null;
      query = '';
      await refresh();
    },
    async forward() {
      if (histIndex >= history.length - 1) return;
      histIndex += 1;
      cwd = history[histIndex];
      selected = null;
      query = '';
      await refresh();
    },
    async open(name) { deps.onOpen(join(cwd, name)); },
    async newFolder(name) { await deps.fs.mkdir(join(cwd, name)); await refresh(); },
    async newFile(name) { await deps.fs.createFile(join(cwd, name)); await refresh(); },
    async remove(name) { await deps.fs.remove(join(cwd, name)); await refresh(); },
    async rename(from, to) { await deps.fs.rename(join(cwd, from), join(cwd, to)); await refresh(); },
    async move(name, destDir) {
      if (destDir === cwd) return;
      await deps.fs.rename(join(cwd, name), join(destDir, name));
      await refresh();
    },
    async listChildren(path) { return sortView(await deps.fs.list(path), 'name', 'asc'); },
    select(name) { selected = name; },
    clearSelection() { selected = null; },
  };
  return model;
}

export interface FileManagerHandle {
  readonly root: HTMLElement;
  readonly model: FileManagerModel;
  readonly ready: Promise<void>;
  /** Remove the document-level listeners this instance installed (call on window close). */
  dispose(): void;
}

interface MenuItem { id: string; label: string; run: () => void; }

/**
 * Render the two-pane file manager (directory tree + entry list) driven by the
 * model: clickable breadcrumb, Back/Forward/Up/New buttons, row selection,
 * double-click to enter/open, a real (DOM) context menu, and HTML5 drag-to-move
 * onto folders (list rows and tree nodes).
 */
export function renderFileManager(doc: Document, deps: FileManagerDeps): FileManagerHandle {
  const model = createFileManagerModel(deps);
  const root = doc.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;background:#1e1e2e;color:#cdd6f4;font:13px sans-serif;position:relative;';

  // --- Toolbar -------------------------------------------------------------
  const bar = doc.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;gap:6px;align-items:center;padding:4px 8px;background:#181825;';
  const backBtn = button(doc, '◀'); backBtn.dataset.action = 'back'; backBtn.title = 'Back';
  const fwdBtn = button(doc, '▶'); fwdBtn.dataset.action = 'forward'; fwdBtn.title = 'Forward';
  const upBtn = button(doc, 'Up'); upBtn.dataset.action = 'up';
  const mkdirBtn = button(doc, 'New Folder');
  const mkfileBtn = button(doc, 'New File');

  const search = doc.createElement('input');
  search.dataset.role = 'fm-search';
  search.type = 'search';
  search.placeholder = 'Search';
  search.style.cssText = 'flex:0 0 160px;padding:3px 8px;border-radius:6px;border:1px solid #45475a;background:#1e1e2e;color:#cdd6f4;font:12px sans-serif;';
  search.addEventListener('input', () => { model.setQuery(search.value); drawList(); });

  const listViewBtn = button(doc, '☰'); listViewBtn.dataset.action = 'view-list'; listViewBtn.title = 'List view';
  const gridViewBtn = button(doc, '⊞'); gridViewBtn.dataset.action = 'view-grid'; gridViewBtn.title = 'Grid view';
  let view: 'list' | 'grid' = 'list';
  listViewBtn.addEventListener('click', () => { view = 'list'; drawList(); });
  gridViewBtn.addEventListener('click', () => { view = 'grid'; drawList(); });

  const sortSel = doc.createElement('select');
  sortSel.dataset.role = 'fm-sort';
  for (const [val, label] of [['name', 'Name'], ['size', 'Size'], ['type', 'Type']] as const) {
    const o = doc.createElement('option'); o.value = val; o.textContent = label; sortSel.appendChild(o);
  }
  sortSel.style.cssText = 'font:12px sans-serif;';
  sortSel.addEventListener('change', () => { model.setSort(sortSel.value as SortKey); drawList(); });

  const crumb = doc.createElement('span');
  crumb.dataset.crumbBar = '';
  crumb.style.cssText = 'flex:1 1 auto;display:flex;flex-wrap:wrap;align-items:center;font:12px ui-monospace,monospace;';
  bar.append(backBtn, fwdBtn, upBtn, mkdirBtn, mkfileBtn, search, listViewBtn, gridViewBtn, sortSel, crumb);

  // --- Panes ---------------------------------------------------------------
  const panes = doc.createElement('div');
  panes.style.cssText = 'flex:1 1 auto;display:flex;min-height:0;';

  const useSidebar = !!deps.locations?.length;
  const tree = doc.createElement('div');
  tree.dataset.pane = useSidebar ? 'sidebar' : 'tree';
  tree.style.cssText = 'flex:0 0 180px;overflow:auto;border-right:1px solid #313244;padding:4px 0;';
  const list = doc.createElement('div');
  list.dataset.pane = 'list';
  list.style.cssText = 'flex:1 1 auto;overflow:auto;';
  panes.append(tree, list);

  root.append(bar, panes);

  let menu: HTMLElement | null = null;
  let dragName: string | null = null;
  const expanded = new Set<string>(); // tree paths whose children are shown
  const treeChildren = new Map<string, Entry[]>(); // loaded dir listings

  // --- Context menu --------------------------------------------------------
  const closeMenu = (): void => { menu?.remove(); menu = null; };
  const openMenu = (x: number, y: number, items: MenuItem[]): void => {
    closeMenu();
    const m = doc.createElement('div');
    m.dataset.menu = '';
    m.style.cssText = `position:absolute;left:${x}px;top:${y}px;z-index:1000;min-width:140px;background:#313244;border:1px solid #45475a;border-radius:4px;padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,.4);`;
    for (const it of items) {
      const el = doc.createElement('div');
      el.dataset.menuItem = it.id;
      el.textContent = it.label;
      el.style.cssText = 'padding:5px 14px;cursor:pointer;white-space:nowrap;';
      el.addEventListener('mouseenter', () => { el.style.background = '#45475a'; });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
      el.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); it.run(); });
      m.appendChild(el);
    }
    root.appendChild(m);
    menu = m;
  };
  const onDocMouseDown = (ev: MouseEvent): void => {
    if (menu && !menu.contains(ev.target as Node)) closeMenu();
  };
  const onDocKeyDown = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') closeMenu(); };
  doc.addEventListener('mousedown', onDocMouseDown);
  doc.addEventListener('keydown', onDocKeyDown);

  const rowMenuItems = (e: Entry): MenuItem[] => [
    { id: 'open', label: 'Open', run: () => { void runOpen(e); } },
    { id: 'open-with', label: 'Open With…', run: () => { void runOpen(e); } },
    { id: 'cut', label: 'Cut', run: () => { model.cut(e.name); } },
    { id: 'copy', label: 'Copy', run: () => { model.copy(e.name); } },
    { id: 'rename', label: 'Rename', run: () => {
      const to = typeof prompt === 'function' ? prompt('New name:', e.name) : null;
      if (to && to !== e.name) void model.rename(e.name, to).then(drawAll);
    } },
    { id: 'delete', label: 'Delete', run: () => { void model.remove(e.name).then(drawAll); } },
  ];
  const emptyMenuItems = (): MenuItem[] => [
    { id: 'new-folder', label: 'New Folder', run: () => {
      const name = typeof prompt === 'function' ? prompt('Folder name:') : null;
      if (name) void model.newFolder(name).then(drawAll);
    } },
    { id: 'new-file', label: 'New File', run: () => {
      const name = typeof prompt === 'function' ? prompt('File name:') : null;
      if (name) void model.newFile(name).then(drawAll);
    } },
    { id: 'paste', label: 'Paste', run: () => { void model.paste().then(drawAll); } },
  ];

  const runOpen = async (e: Entry): Promise<void> => {
    if (e.kind === 'directory') { await model.enter(e.name); drawAll(); }
    else { await model.open(e.name); }
  };

  /** Reflect model.selected onto existing rows in place (no rebuild). */
  const applySelection = (): void => {
    for (const node of list.querySelectorAll<HTMLElement>('[data-name]')) {
      const sel = model.selected === node.dataset.name;
      if (sel) { node.dataset.selected = 'true'; node.style.background = '#45475a'; }
      else { delete node.dataset.selected; node.style.background = ''; }
    }
  };

  // --- List pane -----------------------------------------------------------
  const drawList = (): void => {
    list.dataset.view = view;
    list.style.cssText = view === 'grid'
      ? 'flex:1 1 auto;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;padding:8px;align-content:start;'
      : 'flex:1 1 auto;overflow:auto;';
    list.textContent = '';
    if (model.error) {
      const err = doc.createElement('div');
      err.dataset.error = '';
      err.style.cssText = 'padding:8px 10px;color:#f38ba8;';
      err.textContent = 'Unable to read this folder.';
      list.appendChild(err);
      return;
    }
    for (const e of model.entries) {
      const row = doc.createElement('div');
      row.dataset.name = e.name;
      row.dataset.kind = e.kind;
      row.draggable = true;
      const isSel = model.selected === e.name;
      if (isSel) row.dataset.selected = 'true';
      row.style.cssText = view === 'grid'
        ? `display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 4px;border-radius:8px;cursor:default;user-select:none;${isSel ? 'background:#45475a;' : ''}`
        : `padding:4px 10px;cursor:default;user-select:none;${isSel ? 'background:#45475a;' : ''}`;
      row.textContent = `${e.kind === 'directory' ? '📁' : '📄'} ${e.name}`;

      row.addEventListener('click', (ev) => { ev.stopPropagation(); model.select(e.name); applySelection(); });
      row.addEventListener('dblclick', () => { void runOpen(e); });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        model.select(e.name); applySelection();
        openMenu(menuX(ev), menuY(ev), rowMenuItems(e));
      });

      row.addEventListener('dragstart', (ev) => {
        dragName = e.name;
        ev.dataTransfer?.setData('text/plain', e.name);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });
      if (e.kind === 'directory') {
        row.addEventListener('dragover', (ev) => {
          if (dragName && dragName !== e.name) { ev.preventDefault(); row.style.outline = '1px solid #89b4fa'; }
        });
        row.addEventListener('dragleave', () => { row.style.outline = ''; });
        row.addEventListener('drop', (ev) => {
          ev.preventDefault(); row.style.outline = '';
          void dropMoveInto(join(model.cwd, e.name));
        });
      }
      list.appendChild(row);
    }
  };

  // --- Tree pane -----------------------------------------------------------
  const loadTreeChildren = async (path: string): Promise<Entry[]> => {
    const kids = (await model.listChildren(path)).filter((e) => e.kind === 'directory');
    treeChildren.set(path, kids);
    return kids;
  };

  const treeNode = (path: string, label: string, depth: number): HTMLElement => {
    const wrap = doc.createElement('div');
    const node = doc.createElement('div');
    node.dataset.treePath = path;
    const active = model.cwd === path;
    node.style.cssText = `display:flex;align-items:center;gap:2px;padding:3px 6px;padding-left:${6 + depth * 14}px;cursor:pointer;user-select:none;${active ? 'background:#45475a;' : ''}`;

    const toggle = doc.createElement('span');
    toggle.dataset.treeToggle = path;
    toggle.textContent = expanded.has(path) ? '▾' : '▸';
    toggle.style.cssText = 'width:12px;display:inline-block;text-align:center;';
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void toggleTree(path);
    });

    const labelEl = doc.createElement('span');
    labelEl.textContent = `📁 ${label}`;
    node.append(toggle, labelEl);
    node.addEventListener('click', () => { void model.navigate(path).then(drawAll); });

    // drop target
    node.addEventListener('dragover', (ev) => {
      if (dragName) { ev.preventDefault(); node.style.outline = '1px solid #89b4fa'; }
    });
    node.addEventListener('dragleave', () => { node.style.outline = ''; });
    node.addEventListener('drop', (ev) => {
      ev.preventDefault(); node.style.outline = '';
      void dropMoveInto(path);
    });

    wrap.appendChild(node);
    if (expanded.has(path)) {
      const kids = treeChildren.get(path) ?? [];
      for (const k of kids) wrap.appendChild(treeNode(join(path, k.name), k.name, depth + 1));
    }
    return wrap;
  };

  const toggleTree = async (path: string): Promise<void> => {
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      if (!treeChildren.has(path)) await loadTreeChildren(path);
      expanded.add(path);
    }
    drawTree();
  };

  const drawTree = (): void => {
    tree.textContent = '';
    tree.appendChild(treeNode('/', '/', 0));
  };

  const drawSidebar = (): void => {
    tree.textContent = '';
    for (const loc of deps.locations ?? []) {
      const node = doc.createElement('div');
      node.dataset.location = loc.path;
      const active = model.cwd === loc.path;
      node.style.cssText = `display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;user-select:none;${active ? 'background:#45475a;' : ''}`;
      node.textContent = `${loc.icon ?? '📁'} ${loc.label}`;
      node.addEventListener('click', () => { void model.navigate(loc.path).then(drawAll); });
      // Drop target: move a dragged entry into this location.
      node.addEventListener('dragover', (ev) => { if (dragName) { ev.preventDefault(); node.style.outline = '1px solid #89b4fa'; } });
      node.addEventListener('dragleave', () => { node.style.outline = ''; });
      node.addEventListener('drop', (ev) => { ev.preventDefault(); node.style.outline = ''; void dropMoveInto(loc.path); });
      tree.appendChild(node);
    }
  };

  const dropMoveInto = async (destDir: string): Promise<void> => {
    if (!dragName) return;
    const name = dragName;
    dragName = null;
    await model.move(name, destDir);
    treeChildren.delete(destDir); // invalidate so a fresh expand reloads
    drawAll();
  };

  // --- Breadcrumb ----------------------------------------------------------
  const drawCrumb = (): void => {
    crumb.textContent = '';
    const segs = model.segments;
    segs.forEach((seg, i) => {
      const a = doc.createElement('span');
      a.dataset.crumb = seg.path;
      a.textContent = seg.label;
      a.style.cssText = 'cursor:pointer;padding:0 2px;text-decoration:underline;';
      a.addEventListener('click', () => { void model.navigate(seg.path).then(drawAll); });
      crumb.appendChild(a);
      // separator between non-root segments (root's "/" already reads as a slash)
      if (i > 0 && i < segs.length - 1) {
        const sep = doc.createElement('span');
        sep.textContent = '/';
        sep.style.opacity = '0.5';
        crumb.appendChild(sep);
      }
    });
  };

  const drawButtons = (): void => {
    backBtn.disabled = !model.canBack;
    fwdBtn.disabled = !model.canForward;
  };

  const drawAll = (): void => {
    if (search.value !== model.query) search.value = model.query; // keep the box in sync (query clears on nav)
    drawCrumb(); drawButtons(); if (useSidebar) drawSidebar(); else drawTree(); drawList();
  };

  // --- Wiring --------------------------------------------------------------
  backBtn.addEventListener('click', () => { void model.back().then(drawAll); });
  fwdBtn.addEventListener('click', () => { void model.forward().then(drawAll); });
  upBtn.addEventListener('click', () => { void model.up().then(drawAll); });
  mkdirBtn.addEventListener('click', () => {
    const name = typeof prompt === 'function' ? prompt('Folder name:') : null;
    if (name) void model.newFolder(name).then(drawAll);
  });
  mkfileBtn.addEventListener('click', () => {
    const name = typeof prompt === 'function' ? prompt('File name:') : null;
    if (name) void model.newFile(name).then(drawAll);
  });
  list.addEventListener('contextmenu', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-name]')) return; // row handles its own
    ev.preventDefault();
    model.clearSelection(); applySelection();
    openMenu(menuX(ev), menuY(ev), emptyMenuItems());
  });
  list.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('[data-name]')) { model.clearSelection(); applySelection(); }
  });

  root.tabIndex = 0; // make the manager focusable so it receives key events
  root.addEventListener('keydown', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    // Never hijack copy/cut/paste while the user is typing in a text field (the
    // search box, a future rename field): let the browser's native clipboard win.
    if ((ev.target as Element | null)?.closest('input, textarea, [contenteditable]')) return;
    const key = ev.key.toLowerCase();
    if (key === 'c' && model.selected) { ev.preventDefault(); model.copy(model.selected); }
    else if (key === 'x' && model.selected) { ev.preventDefault(); model.cut(model.selected); }
    else if (key === 'v') { ev.preventDefault(); void model.paste().then(drawAll); }
  });

  const ready = (async () => {
    await model.navigate('/');
    if (!useSidebar) { await loadTreeChildren('/'); expanded.add('/'); }
    drawAll();
  })();

  const dispose = (): void => {
    doc.removeEventListener('mousedown', onDocMouseDown);
    doc.removeEventListener('keydown', onDocKeyDown);
    closeMenu();
  };

  return { root, model, ready, dispose };
}

function menuX(ev: MouseEvent): number { return ev.offsetX ?? ev.clientX; }
function menuY(ev: MouseEvent): number { return ev.offsetY ?? ev.clientY; }

function button(doc: Document, text: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.textContent = text;
  b.style.cssText = 'font:12px sans-serif;cursor:pointer;';
  return b;
}

/** Adapt to a window. */
export function mountFileManager(ctx: WindowContext, deps: FileManagerDeps): FileManagerHandle {
  const h = renderFileManager(ctx.content.ownerDocument, deps);
  ctx.content.appendChild(h.root);
  ctx.setTitle('Files');
  ctx.onClose(() => h.dispose());
  return h;
}

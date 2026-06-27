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
}

export interface FileManagerDeps {
  fs: FileManagerFs;
  /** Launch the app associated with a file (WM wires this to "Open With"). */
  onOpen(path: string): void;
}

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

/** Sort: directories first, then files; each alphabetical (case-insensitive). */
function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
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
  let entries: Entry[] = [];
  let error = false;
  let selected: string | null = null;
  const history: string[] = [];
  let histIndex = -1;

  const refresh = async (): Promise<void> => {
    try {
      entries = sortEntries(await deps.fs.list(cwd));
      error = false;
    } catch {
      entries = [];
      error = true;
    }
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
    await refresh();
  };

  const model: FileManagerModel = {
    get cwd() { return cwd; },
    get entries() { return entries; },
    get error() { return error; },
    get segments() { return pathSegments(cwd); },
    get selected() { return selected; },
    get canBack() { return histIndex > 0; },
    get canForward() { return histIndex < history.length - 1; },
    async navigate(path) { await go(path); },
    async enter(name) { await go(join(cwd, name)); },
    async up() { await go(parentOf(cwd)); },
    async back() {
      if (histIndex <= 0) return;
      histIndex -= 1;
      cwd = history[histIndex];
      selected = null;
      await refresh();
    },
    async forward() {
      if (histIndex >= history.length - 1) return;
      histIndex += 1;
      cwd = history[histIndex];
      selected = null;
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
    async listChildren(path) { return sortEntries(await deps.fs.list(path)); },
    select(name) { selected = name; },
    clearSelection() { selected = null; },
  };
  return model;
}

export interface FileManagerHandle {
  readonly root: HTMLElement;
  readonly model: FileManagerModel;
  readonly ready: Promise<void>;
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
  const crumb = doc.createElement('span');
  crumb.dataset.crumbBar = '';
  crumb.style.cssText = 'flex:1 1 auto;display:flex;flex-wrap:wrap;align-items:center;font:12px ui-monospace,monospace;';
  bar.append(backBtn, fwdBtn, upBtn, mkdirBtn, mkfileBtn, crumb);

  // --- Panes ---------------------------------------------------------------
  const panes = doc.createElement('div');
  panes.style.cssText = 'flex:1 1 auto;display:flex;min-height:0;';
  const tree = doc.createElement('div');
  tree.dataset.pane = 'tree';
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
      row.style.cssText = `padding:4px 10px;cursor:default;user-select:none;${isSel ? 'background:#45475a;' : ''}`;
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

  const drawAll = (): void => { drawCrumb(); drawButtons(); drawTree(); drawList(); };

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

  const ready = (async () => {
    await model.navigate('/');
    await loadTreeChildren('/');
    expanded.add('/');
    drawAll();
  })();

  return { root, model, ready };
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
  return h;
}

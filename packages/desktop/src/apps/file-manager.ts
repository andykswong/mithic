import type { WindowContext } from '../types.ts';

export interface Entry { name: string; kind: 'file' | 'directory'; size?: number; }

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
  navigate(path: string): Promise<void>;
  enter(name: string): Promise<void>;
  up(): Promise<void>;
  open(name: string): Promise<void>;
  newFolder(name: string): Promise<void>;
  newFile(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
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

/** The headless model — navigation + actions, no DOM. Node-testable. */
export function createFileManagerModel(deps: FileManagerDeps): FileManagerModel {
  let cwd = '/';
  let entries: Entry[] = [];
  const refresh = async (): Promise<void> => { entries = sortEntries(await deps.fs.list(cwd)); };

  const model: FileManagerModel = {
    get cwd() { return cwd; },
    get entries() { return entries; },
    async navigate(path) { cwd = path; await refresh(); },
    async enter(name) { cwd = join(cwd, name); await refresh(); },
    async up() { cwd = parentOf(cwd); await refresh(); },
    async open(name) { deps.onOpen(join(cwd, name)); },
    async newFolder(name) { await deps.fs.mkdir(join(cwd, name)); await refresh(); },
    async newFile(name) { await deps.fs.createFile(join(cwd, name)); await refresh(); },
    async remove(name) { await deps.fs.remove(join(cwd, name)); await refresh(); },
    async rename(from, to) { await deps.fs.rename(join(cwd, from), join(cwd, to)); await refresh(); },
  };
  return model;
}

export interface FileManagerHandle {
  readonly root: HTMLElement;
  readonly model: FileManagerModel;
  readonly ready: Promise<void>;
}

/**
 * Render a minimal two-pane DOM (breadcrumb + list) driven by the model. Each
 * row: double-click a directory enters it, double-click a file opens it.
 * Buttons: Up, New Folder, New File. Right-click row → rename/delete via prompt.
 */
export function renderFileManager(doc: Document, deps: FileManagerDeps): FileManagerHandle {
  const model = createFileManagerModel(deps);
  const root = doc.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;background:#1e1e2e;color:#cdd6f4;font:13px sans-serif;';

  const bar = doc.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;gap:6px;align-items:center;padding:4px 8px;background:#181825;';
  const crumb = doc.createElement('span');
  crumb.style.cssText = 'flex:1 1 auto;font:12px ui-monospace,monospace;';
  const upBtn = button(doc, 'Up');
  const mkdirBtn = button(doc, 'New Folder');
  const mkfileBtn = button(doc, 'New File');
  bar.append(upBtn, mkdirBtn, mkfileBtn, crumb);

  const list = doc.createElement('div');
  list.style.cssText = 'flex:1 1 auto;overflow:auto;';

  root.append(bar, list);

  const draw = (): void => {
    crumb.textContent = model.cwd;
    list.textContent = '';
    for (const e of model.entries) {
      const row = doc.createElement('div');
      row.dataset.name = e.name;
      row.dataset.kind = e.kind;
      row.style.cssText = 'padding:4px 10px;cursor:default;user-select:none;';
      row.textContent = `${e.kind === 'directory' ? '📁' : '📄'} ${e.name}`;
      row.addEventListener('dblclick', () => {
        void (async () => {
          if (e.kind === 'directory') { await model.enter(e.name); draw(); }
          else { await model.open(e.name); }
        })();
      });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const action = typeof prompt === 'function' ? prompt(`${e.name}: type "rename" or "delete"`) : null;
        void (async () => {
          if (action === 'delete') { await model.remove(e.name); draw(); }
          else if (action === 'rename') {
            const to = prompt('New name:', e.name);
            if (to) { await model.rename(e.name, to); draw(); }
          }
        })();
      });
      list.appendChild(row);
    }
  };

  upBtn.addEventListener('click', () => { void model.up().then(draw); });
  mkdirBtn.addEventListener('click', () => {
    const name = typeof prompt === 'function' ? prompt('Folder name:') : null;
    if (name) void model.newFolder(name).then(draw);
  });
  mkfileBtn.addEventListener('click', () => {
    const name = typeof prompt === 'function' ? prompt('File name:') : null;
    if (name) void model.newFile(name).then(draw);
  });

  const ready = model.navigate('/').then(draw);
  return { root, model, ready };
}

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

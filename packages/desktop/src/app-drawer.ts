import type { AppDescriptor } from './types.ts';

export interface AppDrawerDeps {
  /** Current launchable apps (called each time the drawer opens, so it reflects registrations). */
  apps(): AppDescriptor[];
  /** Launch an app by name (the host calls `wm.open(name)`). */
  onLaunch(name: string): void;
  /** Optional: pin/unpin an app (right-click a tile). When set, tiles get a context menu. */
  onTogglePin?(name: string): void;
  /** Optional predicate: is this app currently pinned? (drives the context-menu label). */
  isPinned?(name: string): boolean;
}

export interface AppDrawer {
  readonly root: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Detach global listeners (call on desktop teardown). */
  dispose(): void;
}

/** A popup grid launcher (search + icon grid), Android/ChromeOS "all apps" style. */
export function createAppDrawer(doc: Document, deps: AppDrawerDeps): AppDrawer {
  const root = doc.createElement('div');
  root.dataset.role = 'app-drawer';
  root.style.cssText = 'position:absolute;bottom:44px;left:50%;transform:translateX(-50%);'
    + 'width:380px;max-height:60vh;display:none;flex-direction:column;gap:8px;padding:12px;z-index:5000;'
    + 'background:#1e1e2e;border:1px solid #313244;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);';

  const search = doc.createElement('input');
  search.dataset.role = 'drawer-search';
  search.type = 'search';
  search.placeholder = 'Search apps';
  search.style.cssText = 'flex:0 0 auto;padding:6px 10px;border-radius:8px;border:1px solid #45475a;'
    + 'background:#181825;color:#cdd6f4;font:13px sans-serif;';

  const grid = doc.createElement('div');
  grid.dataset.role = 'drawer-grid';
  grid.style.cssText = 'flex:1 1 auto;overflow:auto;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;';

  root.append(search, grid);

  let open = false;

  const applyFilter = (): void => {
    const q = search.value.trim().toLowerCase();
    for (const tile of grid.querySelectorAll<HTMLElement>('[data-app]')) {
      const hay = `${tile.dataset.title ?? ''} ${tile.dataset.app ?? ''}`.toLowerCase();
      tile.style.display = q === '' || hay.includes(q) ? '' : 'none';
    }
  };

  const buildGrid = (): void => {
    grid.textContent = '';
    for (const app of deps.apps()) {
      const tile = doc.createElement('button');
      tile.dataset.app = app.name;
      tile.dataset.title = app.title;
      tile.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px;'
        + 'border:none;border-radius:10px;cursor:pointer;background:transparent;color:#cdd6f4;font:12px sans-serif;';
      const ico = doc.createElement('div'); ico.textContent = app.icon ?? '▫️'; ico.style.fontSize = '26px';
      const label = doc.createElement('div');
      label.textContent = app.title;
      label.style.cssText = 'max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      tile.append(ico, label);
      tile.addEventListener('mouseenter', () => { tile.style.background = '#313244'; });
      tile.addEventListener('mouseleave', () => { tile.style.background = 'transparent'; });
      tile.addEventListener('click', () => { deps.onLaunch(app.name); close(); });
      if (deps.onTogglePin) {
        tile.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          deps.onTogglePin!(app.name);
        });
      }
      grid.appendChild(tile);
    }
    applyFilter();
  };

  const open_ = (): void => {
    buildGrid();
    root.style.display = 'flex';
    open = true;
    search.value = '';
    applyFilter();
    // Focusing lets the user type immediately; guard for headless.
    try { search.focus(); } catch { /* not focusable in some test envs */ }
  };
  const close = (): void => { root.style.display = 'none'; open = false; };
  const toggle = (): void => { open ? close() : open_(); };

  search.addEventListener('input', applyFilter);

  // Global dismissers.
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape' && open) close(); };
  const onDown = (ev: MouseEvent): void => {
    if (!open) return;
    const t = ev.target as Node;
    // Ignore clicks inside the drawer OR on the app-menu button (which toggles us).
    if (root.contains(t) || (t as HTMLElement)?.closest?.('[data-role="app-menu"]')) return;
    close();
  };
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('mousedown', onDown);

  return {
    root,
    open: open_,
    close,
    toggle,
    isOpen: () => open,
    dispose() { doc.removeEventListener('keydown', onKey); doc.removeEventListener('mousedown', onDown); },
  };
}

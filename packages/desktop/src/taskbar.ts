import type { AppDescriptor } from './types.ts';

/** The elements a host wires up after building the taskbar shell. */
export interface TaskbarElements {
  /** The full-width bar; append into the page's `#taskbar` host. */
  readonly root: HTMLElement;
  /** Opens the app drawer (wired by the host). */
  readonly appMenuButton: HTMLButtonElement;
  /** Host renders pinned-app icons here (see `renderPinned`). */
  readonly pinnedRegion: HTMLElement;
  /** The WindowManager renders running-window chips here (pass as `WindowManagerOptions.taskbar`). */
  readonly runningRegion: HTMLElement;
  /** The 1px separator between pinned and running; auto-hidden while the running region is empty. */
  readonly divider: HTMLElement;
  /** Force the divider's visibility. Rarely needed — it auto-tracks the running region. */
  setRunningEmpty(empty: boolean): void;
  /** Disconnect the running-region observer (call on desktop teardown). */
  dispose(): void;
}

export interface TaskbarOptions {
  /** Glyph/emoji for the app-menu button. Default '⊞'. */
  appMenuIcon?: string;
}

/**
 * Build the centered Android-16/ChromeOS-style taskbar shell:
 *   [app menu] [pinned apps] │ [running apps]
 * All movement/rendering is done by the host + WindowManager into the returned regions.
 */
export function createTaskbar(doc: Document, opts: TaskbarOptions = {}): TaskbarElements {
  const root = doc.createElement('div');
  root.dataset.role = 'taskbar-shell';
  root.style.cssText = 'display:flex;justify-content:center;align-items:center;height:100%;width:100%;';

  const group = doc.createElement('div');
  group.dataset.role = 'taskbar-group';
  group.style.cssText = 'display:flex;align-items:center;gap:8px;height:100%;padding:0 10px;'
    + 'background:#181825;border-radius:0;';

  const appMenuButton = doc.createElement('button');
  appMenuButton.dataset.role = 'app-menu';
  appMenuButton.title = 'Apps';
  appMenuButton.textContent = opts.appMenuIcon ?? '⊞';
  appMenuButton.style.cssText = 'flex:0 0 auto;width:28px;height:28px;border:none;border-radius:8px;cursor:pointer;'
    + 'background:#313244;color:#cdd6f4;font:16px sans-serif;line-height:1;';

  const pinnedRegion = doc.createElement('div');
  pinnedRegion.dataset.role = 'pinned';
  pinnedRegion.style.cssText = 'display:flex;gap:4px;align-items:center;';

  const divider = doc.createElement('div');
  divider.dataset.role = 'divider';
  divider.style.cssText = 'width:1px;height:22px;background:#45475a;';

  const runningRegion = doc.createElement('div');
  runningRegion.dataset.role = 'running';
  runningRegion.style.cssText = 'display:flex;gap:4px;align-items:center;';

  group.append(appMenuButton, pinnedRegion, divider, runningRegion);
  root.appendChild(group);

  const setRunningEmpty = (empty: boolean): void => { divider.style.display = empty ? 'none' : 'block'; };
  const syncDivider = (): void => { setRunningEmpty(runningRegion.childElementCount === 0); };
  syncDivider();

  // Auto-track the running region so the WM (which owns its chips) needs no
  // reference to the taskbar: the divider shows exactly when a window is running.
  const Observer = doc.defaultView?.MutationObserver ?? (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const observer = Observer ? new Observer(() => syncDivider()) : undefined;
  observer?.observe(runningRegion, { childList: true });

  return {
    root, appMenuButton, pinnedRegion, runningRegion, divider, setRunningEmpty,
    dispose: () => observer?.disconnect(),
  };
}

export interface RenderPinnedDeps {
  /** App names to show, in shelf order. */
  pins: string[];
  /** Registered apps (to resolve name → icon/title). */
  apps: AppDescriptor[];
  /** Launch an app by name. */
  onLaunch(name: string): void;
  /** Optional: right-click a pinned icon to unpin. */
  onUnpin?(name: string): void;
}

/** (Re)render the pinned-app icons into `region`. Clears the region first. */
export function renderPinned(doc: Document, region: HTMLElement, deps: RenderPinnedDeps): void {
  region.textContent = '';
  const byName = new Map(deps.apps.map((a) => [a.name, a]));
  for (const name of deps.pins) {
    const app = byName.get(name);
    if (!app) continue; // pinned app no longer registered — skip
    const b = doc.createElement('button');
    b.dataset.pinnedApp = name;
    b.title = app.title;
    b.textContent = app.icon ?? '▫️';
    b.style.cssText = 'flex:0 0 auto;width:28px;height:28px;border:none;border-radius:8px;cursor:pointer;'
      + 'background:#313244;color:#cdd6f4;font:16px sans-serif;line-height:1;';
    b.addEventListener('click', () => deps.onLaunch(name));
    if (deps.onUnpin) {
      b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); deps.onUnpin!(name); });
    }
    region.appendChild(b);
  }
}

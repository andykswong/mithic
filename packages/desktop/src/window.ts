import type { MithicWindow, Rect } from './types.ts';

export interface WindowFrameElements {
  titlebar: HTMLElement;
  titleText: HTMLElement;
  minimizeBtn: HTMLButtonElement;
  maximizeBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  resizeHandle: HTMLElement;
}

export interface CreateWindowOptions {
  id: number;
  title: string;
  geometry: Rect;
  resizable?: boolean;
}

/** Build the window chrome (titlebar + content + resize handle). Pure DOM. */
export function createWindowFrame(
  doc: Document,
  opts: CreateWindowOptions,
): { window: MithicWindow; els: WindowFrameElements } {
  const frame = doc.createElement('div');
  frame.dataset.role = 'window';
  frame.dataset.id = String(opts.id);
  frame.style.cssText = 'position:absolute;top:0;left:0;display:flex;flex-direction:column;'
    + 'box-shadow:0 8px 24px rgba(0,0,0,.4);border-radius:6px;overflow:hidden;background:#1e1e2e;'
    + 'will-change:transform;';

  const titlebar = doc.createElement('div');
  titlebar.dataset.role = 'titlebar';
  titlebar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;'
    + 'background:#313244;color:#cdd6f4;font:12px sans-serif;cursor:move;user-select:none;';
  const titleText = doc.createElement('span');
  titleText.dataset.role = 'title';
  titleText.style.cssText = 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  titleText.textContent = opts.title;

  const minimizeBtn = chromeButton(doc, '–');
  const maximizeBtn = chromeButton(doc, '□');
  const closeBtn = chromeButton(doc, '✕');
  titlebar.append(titleText, minimizeBtn, maximizeBtn, closeBtn);

  const content = doc.createElement('div');
  content.dataset.role = 'content';
  content.style.cssText = 'flex:1 1 auto;position:relative;overflow:hidden;background:#1e1e2e;';

  const resizeHandle = doc.createElement('div');
  resizeHandle.dataset.role = 'resize';
  resizeHandle.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;'
    + (opts.resizable === false ? 'display:none;' : '');

  frame.append(titlebar, content, resizeHandle);

  const window: MithicWindow = {
    id: opts.id,
    title: opts.title,
    frame,
    content,
    state: 'normal',
    geometry: { ...opts.geometry },
    z: 0,
  };

  return { window, els: { titlebar, titleText, minimizeBtn, maximizeBtn, closeBtn, resizeHandle } };
}

/** Write geometry to the frame via transform (compositor-friendly) + size. CSS only. */
export function applyGeometry(win: MithicWindow): void {
  const { x, y, w, h } = win.geometry;
  win.frame.style.transform = `translate3d(${x}px, ${y}px, 0px)`;
  win.frame.style.width = `${w}px`;
  win.frame.style.height = `${h}px`;
}

/** Reflect window state: minimized = display:none (frame stays mounted, so a child iframe survives). */
export function applyState(win: MithicWindow): void {
  win.frame.style.display = win.state === 'minimized' ? 'none' : 'flex';
}

/** Update the visible title (titlebar). */
export function setWindowTitle(win: MithicWindow, els: WindowFrameElements, title: string): void {
  win.title = title;
  els.titleText.textContent = title;
}

function chromeButton(doc: Document, glyph: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.textContent = glyph;
  b.style.cssText = 'flex:0 0 auto;width:20px;height:20px;border:none;border-radius:4px;cursor:pointer;'
    + 'background:transparent;color:inherit;font:12px sans-serif;line-height:1;';
  return b;
}

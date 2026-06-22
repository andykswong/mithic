/** Body class applied for the duration of a drag/resize gesture. */
export const SHIELD_CLASS = 'mithic-wm-dragging';
const STYLE_ID = 'mithic-wm-shield-style';

/**
 * Inject the pointer-shield stylesheet once. While `body.${SHIELD_CLASS}` is set,
 * ALL iframes ignore pointer events, so a drag gesture keeps reaching the host's
 * document-level move listeners instead of being swallowed by an iframe the
 * cursor crosses. Idempotent.
 */
export function installShieldStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `.${SHIELD_CLASS} iframe { pointer-events: none; }`;
  doc.head.appendChild(style);
}

function beginShield(doc: Document): void { doc.body.classList.add(SHIELD_CLASS); }
function endShield(doc: Document): void { doc.body.classList.remove(SHIELD_CLASS); }

export interface DragOptions {
  /** Returns the geometry origin (x,y) at gesture start. */
  onStart(): { x: number; y: number };
  /** Called on each move with the new absolute x,y. */
  onMove(x: number, y: number): void;
  onEnd?(): void;
}

/** Make `handle` start a move gesture on pointerdown. Returns a disposer. */
export function makeDraggable(handle: HTMLElement, opts: DragOptions): () => void {
  const doc = handle.ownerDocument;
  const onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const origin = opts.onStart();
    const startX = e.clientX;
    const startY = e.clientY;
    beginShield(doc);
    try { handle.setPointerCapture(e.pointerId); } catch { /* not capturable */ }

    const onMove = (ev: PointerEvent): void => {
      opts.onMove(origin.x + (ev.clientX - startX), origin.y + (ev.clientY - startY));
    };
    const onUp = (): void => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      endShield(doc);
      opts.onEnd?.();
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', onDown);
  return () => handle.removeEventListener('pointerdown', onDown);
}

export interface ResizeOptions {
  /** Returns the size (w,h) at gesture start. */
  onStart(): { w: number; h: number };
  /** Called on each move with the new w,h (already min-clamped by the caller if needed). */
  onMove(w: number, h: number): void;
  onEnd?(): void;
  minW?: number;
  minH?: number;
}

/** Make `handle` start a resize gesture on pointerdown. Returns a disposer. */
export function makeResizable(handle: HTMLElement, opts: ResizeOptions): () => void {
  const doc = handle.ownerDocument;
  const minW = opts.minW ?? 120;
  const minH = opts.minH ?? 80;
  const onDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const start = opts.onStart();
    const startX = e.clientX;
    const startY = e.clientY;
    beginShield(doc);
    try { handle.setPointerCapture(e.pointerId); } catch { /* not capturable */ }

    const onMove = (ev: PointerEvent): void => {
      opts.onMove(
        Math.max(minW, start.w + (ev.clientX - startX)),
        Math.max(minH, start.h + (ev.clientY - startY)),
      );
    };
    const onUp = (): void => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      endShield(doc);
      opts.onEnd?.();
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', onDown);
  return () => handle.removeEventListener('pointerdown', onDown);
}

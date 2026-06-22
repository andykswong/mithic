import type { Rect } from './types.ts';

/** Smallest allowed window size (px). */
export const DEFAULT_MIN_SIZE = { w: 160, h: 100 } as const;

/** Cascade origin + per-window step (px). */
const CASCADE_ORIGIN = 24;
const CASCADE_STEP = 28;

/** Available desktop area. */
export interface Bounds { w: number; h: number; }

/**
 * Clamp a rect so it fits inside `bounds`: enforce the min size, cap the size at
 * the bounds, then pull the origin so the rect stays fully visible (origin >= 0).
 */
export function clampToBounds(r: Rect, bounds: Bounds): Rect {
  const w = Math.min(Math.max(r.w, DEFAULT_MIN_SIZE.w), bounds.w);
  const h = Math.min(Math.max(r.h, DEFAULT_MIN_SIZE.h), bounds.h);
  const x = Math.min(Math.max(r.x, 0), Math.max(0, bounds.w - w));
  const y = Math.min(Math.max(r.y, 0), Math.max(0, bounds.h - h));
  return { x, y, w, h };
}

/**
 * Default placement for the Nth opened window: a diagonal cascade from the
 * top-left, wrapping back to the origin (modulo) before it would overflow.
 */
export function cascadePlacement(index: number, size: [number, number], bounds: Bounds): Rect {
  const [w, h] = size;
  const maxStepsX = Math.max(1, Math.floor((bounds.w - w - CASCADE_ORIGIN) / CASCADE_STEP));
  const maxStepsY = Math.max(1, Math.floor((bounds.h - h - CASCADE_ORIGIN) / CASCADE_STEP));
  const steps = Math.min(maxStepsX, maxStepsY);
  const n = steps > 0 ? index % steps : 0;
  return clampToBounds(
    { x: CASCADE_ORIGIN + n * CASCADE_STEP, y: CASCADE_ORIGIN + n * CASCADE_STEP, w, h },
    bounds,
  );
}

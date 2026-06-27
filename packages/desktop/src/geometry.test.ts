import { describe, expect, test } from 'vitest';
import { clampToBounds, cascadePlacement, DEFAULT_MIN_SIZE } from './geometry.ts';
import type { Rect } from './types.ts';

const bounds = { w: 1000, h: 800 };

describe('clampToBounds', () => {
  test('keeps an in-bounds rect unchanged', () => {
    const r: Rect = { x: 100, y: 100, w: 300, h: 200 };
    expect(clampToBounds(r, bounds)).toEqual(r);
  });
  test('pulls an off-right/bottom rect back inside', () => {
    const r: Rect = { x: 900, y: 700, w: 300, h: 200 };
    expect(clampToBounds(r, bounds)).toEqual({ x: 700, y: 600, w: 300, h: 200 });
  });
  test('clamps negative origin to 0', () => {
    expect(clampToBounds({ x: -50, y: -20, w: 160, h: 100 }, bounds)).toEqual({ x: 0, y: 0, w: 160, h: 100 });
  });
  test('clamps a too-large size to the bounds and enforces min size', () => {
    const out = clampToBounds({ x: 0, y: 0, w: 5000, h: 5000 }, bounds);
    expect(out.w).toBe(1000);
    expect(out.h).toBe(800);
    const tiny = clampToBounds({ x: 0, y: 0, w: 1, h: 1 }, bounds);
    expect(tiny.w).toBe(DEFAULT_MIN_SIZE.w);
    expect(tiny.h).toBe(DEFAULT_MIN_SIZE.h);
  });
  test('when bounds are smaller than the min size, the size caps at the bounds (cap wins over min)', () => {
    const small = { w: 50, h: 40 };
    const out = clampToBounds({ x: 100, y: 100, w: 300, h: 200 }, small);
    // min would be 160x100, but the bounds cap is applied last so the window
    // can never exceed the (tiny) desktop.
    expect(out.w).toBe(50);
    expect(out.h).toBe(40);
    // Origin is pulled to 0 since bounds.w - w === 0.
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });
});

describe('cascadePlacement', () => {
  test('places the first window near the top-left', () => {
    expect(cascadePlacement(0, [400, 300], bounds)).toEqual({ x: 24, y: 24, w: 400, h: 300 });
  });
  test('offsets each subsequent window by a step', () => {
    expect(cascadePlacement(2, [400, 300], bounds)).toEqual({ x: 24 + 2 * 28, y: 24 + 2 * 28, w: 400, h: 300 });
  });
  test('wraps the cascade when it would overflow the bounds', () => {
    const r = cascadePlacement(40, [400, 300], bounds);
    expect(r.x).toBeGreaterThanOrEqual(24);
    expect(r.x + r.w).toBeLessThanOrEqual(bounds.w);
    expect(r.y + r.h).toBeLessThanOrEqual(bounds.h);
  });
  test('clamps steps to >=1 and stays in bounds when bounds are smaller than the window', () => {
    // bounds < window size: (bounds.w - w - origin) is negative, so the step count
    // would go <=0; it must clamp to >=1 (n = index % 1 = 0, no NaN/div-by-zero)
    // and the result must still be fully inside the (tiny) bounds.
    const small = { w: 300, h: 250 };
    for (const index of [0, 3, 40]) {
      const r = cascadePlacement(index, [400, 300], small);
      expect(r.x).toBe(0);
      expect(r.y).toBe(0);
      expect(r.x + r.w).toBeLessThanOrEqual(small.w);
      expect(r.y + r.h).toBeLessThanOrEqual(small.h);
      expect(Number.isFinite(r.x)).toBe(true);
      expect(Number.isFinite(r.y)).toBe(true);
    }
  });
});

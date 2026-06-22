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
});

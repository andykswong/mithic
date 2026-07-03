import { expect, test } from 'vitest';
import { makeDraggable, makeResizable, SHIELD_CLASS, installShieldStyle } from './drag.ts';

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1 });
}

test('dragging the handle reports new positions and toggles the iframe shield', () => {
  installShieldStyle(document);
  const handle = document.createElement('div');
  document.body.appendChild(handle);

  const moves: Array<{ dx: number; dy: number }> = [];
  makeDraggable(handle, {
    onStart: () => ({ x: 100, y: 100 }),
    onMove: (x, y) => { moves.push({ dx: x, dy: y }); },
  });

  handle.dispatchEvent(pointer('pointerdown', 200, 200));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);

  document.dispatchEvent(pointer('pointermove', 230, 250));
  // origin (100,100) + delta (30,50) = (130,150)
  expect(moves.at(-1)).toEqual({ dx: 130, dy: 150 });

  document.dispatchEvent(pointer('pointerup', 230, 250));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(false);

  handle.remove();
});

test('installShieldStyle injects a rule that disables iframe pointer events while dragging', () => {
  installShieldStyle(document);
  const style = document.getElementById('mithic-wm-shield-style');
  expect(style).not.toBeNull();
  expect(style!.textContent).toContain(`.${SHIELD_CLASS} iframe`);
  expect(style!.textContent).toContain('pointer-events: none');
});

test('pointercancel ends the gesture: clears the shield and detaches the move listener (M3)', () => {
  installShieldStyle(document);
  const handle = document.createElement('div');
  document.body.appendChild(handle);

  const moves: Array<{ dx: number; dy: number }> = [];
  makeDraggable(handle, {
    onStart: () => ({ x: 0, y: 0 }),
    onMove: (x, y) => { moves.push({ dx: x, dy: y }); },
  });

  handle.dispatchEvent(pointer('pointerdown', 10, 10));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);

  // A pointercancel (e.g. OS-level gesture takeover) must end the gesture exactly
  // like pointerup: clear the shield and stop tracking moves.
  document.dispatchEvent(pointer('pointercancel', 10, 10));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(false);

  const movesAfterCancel = moves.length;
  document.dispatchEvent(pointer('pointermove', 50, 50));
  expect(moves.length).toBe(movesAfterCancel); // listener detached — no more moves

  handle.remove();
});

test('shield is refcounted: two overlapping drags keep it until both end (M3)', () => {
  installShieldStyle(document);
  const a = document.createElement('div');
  const b = document.createElement('div');
  document.body.appendChild(a);
  document.body.appendChild(b);

  makeDraggable(a, { onStart: () => ({ x: 0, y: 0 }), onMove: () => {} });
  makeDraggable(b, { onStart: () => ({ x: 0, y: 0 }), onMove: () => {} });

  a.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, pointerId: 1, bubbles: true }));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);

  b.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, pointerId: 2, bubbles: true }));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);

  // Ending A must NOT clear the shield — B's gesture is still active.
  document.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0, pointerId: 1, bubbles: true }));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);

  // Ending B brings the refcount to 0 — now the shield clears.
  document.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0, pointerId: 2, bubbles: true }));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(false);

  a.remove();
  b.remove();
});

test('makeResizable reports new sizes, toggles the shield, and fires onEnd', () => {
  installShieldStyle(document);
  const handle = document.createElement('div');
  document.body.appendChild(handle);

  const sizes: Array<{ w: number; h: number }> = [];
  let ended = false;
  makeResizable(handle, {
    onStart: () => ({ w: 300, h: 200 }),
    onMove: (w, h) => { sizes.push({ w, h }); },
    onEnd: () => { ended = true; },
  });

  handle.dispatchEvent(pointer('pointerdown', 500, 400));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);

  // +50 in x, +30 in y from start.
  document.dispatchEvent(pointer('pointermove', 550, 430));
  expect(sizes.at(-1)).toEqual({ w: 350, h: 230 });

  document.dispatchEvent(pointer('pointerup', 550, 430));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(false);
  expect(ended).toBe(true);

  handle.remove();
});

test('makeResizable clamps to minW/minH when dragging smaller', () => {
  installShieldStyle(document);
  const handle = document.createElement('div');
  document.body.appendChild(handle);

  const sizes: Array<{ w: number; h: number }> = [];
  makeResizable(handle, {
    onStart: () => ({ w: 200, h: 150 }),
    onMove: (w, h) => { sizes.push({ w, h }); },
    minW: 120,
    minH: 80,
  });

  handle.dispatchEvent(pointer('pointerdown', 400, 400));
  // Drag far up-left (would compute 200-300=-100 / 150-300=-150) → clamps to min.
  document.dispatchEvent(pointer('pointermove', 100, 100));
  expect(sizes.at(-1)).toEqual({ w: 120, h: 80 });

  document.dispatchEvent(pointer('pointerup', 100, 100));
  handle.remove();
});

test('makeDraggable ignores a pointerdown that originated on a child button (Bug A regression)', () => {
  installShieldStyle(document);
  const handle = document.createElement('div');   // stands in for the titlebar
  const btn = document.createElement('button');   // a chrome button, child of the handle
  handle.appendChild(btn);
  document.body.appendChild(handle);

  let started = false;
  makeDraggable(handle, { onStart: () => { started = true; return { x: 0, y: 0 }; }, onMove: () => {} });

  // A real user pressing the button produces a pointerdown whose target is the button,
  // bubbling to the handle. The drag must NOT engage (no onStart, no shield) — otherwise
  // setPointerCapture on the handle steals the click and the button never fires.
  btn.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, pointerId: 1, bubbles: true }));

  expect(started).toBe(false);
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(false);

  handle.remove();
});

test('makeDraggable still starts a drag when the pointerdown is on the handle body', () => {
  installShieldStyle(document);
  const handle = document.createElement('div');
  document.body.appendChild(handle);
  let started = false;
  makeDraggable(handle, { onStart: () => { started = true; return { x: 0, y: 0 }; }, onMove: () => {} });

  handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, pointerId: 1, bubbles: true }));
  expect(started).toBe(true);
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);

  handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 5, clientY: 5, pointerId: 1, bubbles: true }));
  handle.remove();
});

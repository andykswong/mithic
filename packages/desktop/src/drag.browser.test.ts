import { expect, test } from 'vitest';
import { makeDraggable, SHIELD_CLASS, installShieldStyle } from './drag.ts';

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

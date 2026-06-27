import { expect, test } from 'vitest';
import { createWindowFrame, applyGeometry, applyState } from './window.ts';

test('createWindowFrame builds titlebar + content and reflects title', () => {
  const { window: win, els } = createWindowFrame(document, { id: 1, title: 'Hello', geometry: { x: 10, y: 20, w: 300, h: 200 } });
  document.body.appendChild(win.frame);

  expect(win.frame.querySelector('[data-role="titlebar"]')).not.toBeNull();
  expect(win.content).toBe(win.frame.querySelector('[data-role="content"]'));
  expect(els.titleText.textContent).toBe('Hello');
  expect(els.closeBtn).toBeTruthy();
  expect(els.minimizeBtn).toBeTruthy();
  expect(els.maximizeBtn).toBeTruthy();

  win.frame.remove();
});

test('applyGeometry positions the frame via transform + size', () => {
  const { window: win } = createWindowFrame(document, { id: 2, title: 'G', geometry: { x: 40, y: 50, w: 320, h: 240 } });
  document.body.appendChild(win.frame);
  applyGeometry(win);
  expect(win.frame.style.transform).toBe('translate3d(40px, 50px, 0px)');
  expect(win.frame.style.width).toBe('320px');
  expect(win.frame.style.height).toBe('240px');
  win.frame.remove();
});

test('applyState: minimized hides via display:none (frame stays in DOM)', () => {
  const { window: win } = createWindowFrame(document, { id: 3, title: 'M', geometry: { x: 0, y: 0, w: 200, h: 150 } });
  document.body.appendChild(win.frame);
  win.state = 'minimized';
  applyState(win);
  expect(win.frame.style.display).toBe('none');
  // Crucial: the frame is NOT removed from the DOM (so a child iframe would survive).
  expect(win.frame.isConnected).toBe(true);

  win.state = 'normal';
  applyState(win);
  expect(win.frame.style.display).not.toBe('none');
  win.frame.remove();
});

test('applyState: maximized shows the frame (display:flex)', () => {
  const { window: win } = createWindowFrame(document, { id: 4, title: 'Mx', geometry: { x: 0, y: 0, w: 200, h: 150 } });
  document.body.appendChild(win.frame);
  win.state = 'maximized';
  applyState(win);
  expect(win.frame.style.display).toBe('flex');
  expect(win.frame.isConnected).toBe(true);
  win.frame.remove();
});

test('createWindowFrame with resizable:false hides the resize handle (display:none)', () => {
  const { window: win, els } = createWindowFrame(document, { id: 5, title: 'NR', geometry: { x: 0, y: 0, w: 200, h: 150 }, resizable: false });
  document.body.appendChild(win.frame);
  expect(els.resizeHandle.style.display).toBe('none');

  // A resizable window (the default) keeps the handle visible.
  const { els: els2 } = createWindowFrame(document, { id: 6, title: 'R', geometry: { x: 0, y: 0, w: 200, h: 150 } });
  expect(els2.resizeHandle.style.display).not.toBe('none');

  win.frame.remove();
});

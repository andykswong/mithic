import { expect, test, vi } from 'vitest';
import { createTaskbar, renderPinned } from './taskbar.ts';
import type { AppDescriptor } from './types.ts';

test('createTaskbar builds a centered shell with app-menu, pinned, divider, and running regions in order', () => {
  const t = createTaskbar(document);
  document.body.appendChild(t.root);

  // Regions exist and are exposed.
  expect(t.appMenuButton.dataset.role).toBe('app-menu');
  expect(t.pinnedRegion.dataset.role).toBe('pinned');
  expect(t.runningRegion.dataset.role).toBe('running');

  // DOM order: app-menu, pinned, divider, running (left→right).
  const roles = [...t.root.querySelector('[data-role="taskbar-group"]')!.children]
    .map((c) => (c as HTMLElement).dataset.role);
  expect(roles).toEqual(['app-menu', 'pinned', 'divider', 'running']);

  // The group is centered.
  expect(t.root.style.justifyContent).toBe('center');

  t.root.remove();
});

test('divider auto-hides when the running region is empty and shows when it has items', async () => {
  const t = createTaskbar(document);
  document.body.appendChild(t.root);
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // Empty running region → divider hidden.
  expect(t.divider.style.display).toBe('none');

  // Add a running chip → divider shows (MutationObserver fires async).
  const chip = document.createElement('button');
  chip.dataset.role = 'taskbar-item';
  t.runningRegion.appendChild(chip);
  await settle();
  expect(t.divider.style.display).not.toBe('none');

  // Remove it → divider hides again.
  chip.remove();
  await settle();
  expect(t.divider.style.display).toBe('none');

  t.dispose();
  t.root.remove();
});

test('renderPinned draws one icon button per pinned app and launches on click', () => {
  const apps: AppDescriptor[] = [
    { name: 'terminal', title: 'Terminal', icon: '🖥️', defaultSize: [640, 400], mount: () => {} },
    { name: 'files', title: 'Files', icon: '📁', defaultSize: [560, 420], mount: () => {} },
  ];
  const region = document.createElement('div');
  const onLaunch = vi.fn();
  renderPinned(document, region, { pins: ['files', 'terminal'], apps, onLaunch });

  const btns = region.querySelectorAll('[data-pinned-app]');
  expect([...btns].map((b) => (b as HTMLElement).dataset.pinnedApp)).toEqual(['files', 'terminal']); // pin order
  (btns[0] as HTMLElement).click();
  expect(onLaunch).toHaveBeenCalledWith('files');
});

test('renderPinned triggers onUnpin via right-click (contextmenu) without launching', () => {
  const apps: AppDescriptor[] = [
    { name: 'terminal', title: 'Terminal', icon: '🖥️', defaultSize: [640, 400], mount: () => {} },
    { name: 'files', title: 'Files', icon: '📁', defaultSize: [560, 420], mount: () => {} },
  ];
  const region = document.createElement('div');
  const onLaunch = vi.fn();
  const onUnpin = vi.fn();
  renderPinned(document, region, { pins: ['files', 'terminal'], apps, onLaunch, onUnpin });

  const btns = region.querySelectorAll('[data-pinned-app]');
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  (btns[0] as HTMLElement).dispatchEvent(ev);
  expect(onUnpin).toHaveBeenCalledWith('files');
  expect(onLaunch).not.toHaveBeenCalled();
  expect(ev.defaultPrevented).toBe(true); // suppress the native context menu
});

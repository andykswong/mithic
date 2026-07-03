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

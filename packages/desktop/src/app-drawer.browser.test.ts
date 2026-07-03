import { expect, test, vi } from 'vitest';
import { createAppDrawer } from './app-drawer.ts';
import type { AppDescriptor } from './types.ts';

const APPS: AppDescriptor[] = [
  { name: 'terminal', title: 'Terminal', icon: '🖥️', defaultSize: [640, 400], mount: () => {} },
  { name: 'files', title: 'Files', icon: '📁', defaultSize: [560, 420], mount: () => {} },
  { name: 'editor', title: 'Editor', icon: '📝', defaultSize: [600, 420], mount: () => {} },
];

test('app drawer renders an icon grid of apps and launches on click', () => {
  const onLaunch = vi.fn();
  const d = createAppDrawer(document, { apps: () => APPS, onLaunch });
  document.body.appendChild(d.root);

  d.open();
  expect(d.isOpen()).toBe(true);
  const tiles = d.root.querySelectorAll('[data-app]');
  expect(tiles.length).toBe(3);

  (d.root.querySelector('[data-app="files"]') as HTMLElement).click();
  expect(onLaunch).toHaveBeenCalledWith('files');
  expect(d.isOpen()).toBe(false); // launching closes the drawer

  d.root.remove();
});

test('search box filters tiles by title (case-insensitive)', () => {
  const d = createAppDrawer(document, { apps: () => APPS, onLaunch: () => {} });
  document.body.appendChild(d.root);
  d.open();

  const search = d.root.querySelector('[data-role="drawer-search"]') as HTMLInputElement;
  search.value = 'edit';
  search.dispatchEvent(new Event('input', { bubbles: true }));

  const visible = [...d.root.querySelectorAll('[data-app]')].filter((el) => (el as HTMLElement).style.display !== 'none');
  expect(visible.map((el) => (el as HTMLElement).dataset.app)).toEqual(['editor']);

  d.root.remove();
});

test('Escape and outside-click close the drawer', () => {
  const d = createAppDrawer(document, { apps: () => APPS, onLaunch: () => {} });
  document.body.appendChild(d.root);
  d.open();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(d.isOpen()).toBe(false);

  d.open();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  expect(d.isOpen()).toBe(false);

  d.root.remove();
});

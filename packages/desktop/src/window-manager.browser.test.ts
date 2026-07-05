import { expect, test, vi } from 'vitest';
import { WindowManager } from './window-manager.ts';
import { AppRegistry, appDescriptorFromManifest } from './app-registry.ts';
import { SHIELD_CLASS } from './drag.ts';
import type { AppDescriptor } from './types.ts';

// Minimal fake kernel: records spawn/kill and lets us resolve wait() on demand.
function fakeKernel() {
  let nextPid = 100;
  const waiters = new Map<number, (v: { code: number }) => void>();
  return {
    spawnCalls: [] as Array<{ code: unknown; init: any }>,
    killed: [] as Array<{ pid: number; sig: string }>,
    async spawn(code: unknown, init: any) {
      const pid = nextPid++;
      this.spawnCalls.push({ code, init });
      return { pid };
    },
    wait(pid: number) { return new Promise<{ code: number }>((res) => waiters.set(pid, res)); },
    kill(pid: number, sig: string) { this.killed.push({ pid, sig }); waiters.get(pid)?.({ code: 143 }); },
  };
}

function setupDesktop() {
  const desktop = document.createElement('div');
  desktop.style.cssText = 'position:relative;width:1000px;height:700px;';
  document.body.appendChild(desktop);
  return desktop;
}

test('open() mounts a tier-1 app into a window frame in the desktop', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  const mount = vi.fn((ctx) => { ctx.content.appendChild(document.createElement('p')); });
  const editor: AppDescriptor = { name: 'editor', title: 'Editor', defaultSize: [400, 300], mount };
  apps.register(editor);
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const win = await wm.open('editor');
  expect(desktop.querySelector('[data-role="window"]')).toBe(win.frame);
  expect(mount).toHaveBeenCalledTimes(1);
  expect(win.content.querySelector('p')).not.toBeNull();
  expect(wm.windows.length).toBe(1);

  wm.dispose();
  desktop.remove();
});

test('open() of a tier-2 app spawns a guest into the window content container', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'viewer', title: 'Viewer', defaultSize: [500, 400], entry: 'CODE;', capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }] });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const win = await wm.open('viewer');
  expect(kernel.spawnCalls.length).toBe(1);
  const call = kernel.spawnCalls[0];
  expect(call.code).toBe('CODE;');
  expect(call.init.display.mode).toBe('window');
  expect(call.init.display.container).toBe(win.content);
  expect(call.init.capabilities).toEqual([{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  expect(win.pid).toBe(100);

  wm.dispose();
  desktop.remove();
});

test('open() threads an app\'s declared displayMode into the tier-2 spawn display', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  // A tier-2 app that declares a non-default display mode in its manifest. The WM
  // must forward `app.displayMode` (not a hard-coded 'window') into kernel.spawn's
  // display.mode so the guest learns its true display mode.
  apps.register({ name: 'bg', title: 'Background', defaultSize: [400, 300], entry: 'CODE;', displayMode: 'hidden' });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  await wm.open('bg');
  expect(kernel.spawnCalls.length).toBe(1);
  expect(kernel.spawnCalls[0].init.display.mode).toBe('hidden');

  wm.dispose();
  desktop.remove();
});

test('open() threads the manifest-compiled csp into the tier-2 spawn (G6-CSP-manifest §9)', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  // A tier-2 app registered from a manifest: appDescriptorFromManifest compiles the
  // manifest `assets` into `descriptor.csp`, and the WM must forward it into
  // kernel.spawn's `csp` so the guest iframe applies exactly its manifest policy.
  const viewer = appDescriptorFromManifest(
    { name: 'viewer', assets: { img: true } },
    { entry: 'CODE;' },
  );
  apps.register(viewer);
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  await wm.open('viewer');
  expect(kernel.spawnCalls.length).toBe(1);
  expect(kernel.spawnCalls[0].init.csp).toBe(viewer.csp);
  expect(kernel.spawnCalls[0].init.csp).toContain('img-src blob: data:');

  wm.dispose();
  desktop.remove();
});

test('open() of a manifest-less tier-2 app leaves csp undefined (DEFAULT_GUEST_CSP fallback)', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  // A hand-registered descriptor with no csp field → the WM passes csp: undefined
  // and the iframe backend falls back to DEFAULT_GUEST_CSP.
  apps.register({ name: 'plain', title: 'Plain', defaultSize: [400, 300], entry: 'CODE;' });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  await wm.open('plain');
  expect(kernel.spawnCalls.length).toBe(1);
  expect(kernel.spawnCalls[0].init.csp).toBeUndefined();

  wm.dispose();
  desktop.remove();
});

test('a failed tier-2 spawn removes the ghost frame and rethrows (M4)', async () => {
  const desktop = setupDesktop();
  // Fake kernel whose spawn always rejects (e.g. runtime/capability failure).
  const kernel = {
    async spawn() { throw new Error('spawn failed'); },
    async wait() { return { code: 0 }; },
    kill() {},
  };
  const apps = new AppRegistry();
  apps.register({ name: 'viewer', title: 'V', defaultSize: [400, 300], entry: 'CODE;' });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  await expect(wm.open('viewer')).rejects.toThrow('spawn failed');
  // No ghost frame or tracked window must remain after the failed spawn.
  expect(desktop.querySelector('[data-role="window"]')).toBeNull();
  expect(wm.windows.length).toBe(0);

  wm.dispose(); desktop.remove();
});

test('closing a tier-2 window kills the guest with SIGTERM and removes the frame', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'viewer', title: 'V', defaultSize: [300, 200], entry: 'X;' });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });
  const win = await wm.open('viewer');

  wm.close(win.id);
  expect(kernel.killed).toEqual([{ pid: win.pid, sig: 'SIGTERM' }]);
  expect(desktop.querySelector('[data-role="window"]')).toBeNull();
  expect(wm.windows.length).toBe(0);

  wm.dispose(); desktop.remove();
});

test('guest exit auto-closes its window', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'v', title: 'V', defaultSize: [300, 200], entry: 'X;' });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });
  const win = await wm.open('v');
  expect(wm.windows.length).toBe(1);

  // Simulate the guest exiting: kill resolves the wait() the WM is awaiting.
  kernel.kill(win.pid!, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 0));
  expect(wm.windows.length).toBe(0);

  wm.dispose(); desktop.remove();
});

test('focus raises z-order (monotonic)', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [200, 150], mount: () => {} });
  apps.register({ name: 'b', title: 'B', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const a = await wm.open('a');
  const b = await wm.open('b');
  expect(b.z).toBeGreaterThan(a.z); // newest on top
  wm.focus(a.id);
  expect(a.z).toBeGreaterThan(b.z); // focusing a raises it above b

  wm.dispose(); desktop.remove();
});

test('singleton app focuses the existing window instead of opening a second', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'files', title: 'Files', defaultSize: [400, 300], singleton: true, mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const first = await wm.open('files');
  const second = await wm.open('files');
  expect(second).toBe(first);
  expect(wm.windows.length).toBe(1);

  wm.dispose(); desktop.remove();
});

test('minimize hides the frame without removing it; restore shows it', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });
  const win = await wm.open('a');

  wm.minimize(win.id);
  expect(win.state).toBe('minimized');
  expect(win.frame.style.display).toBe('none');
  expect(win.frame.isConnected).toBe(true); // NOT removed — guest/content survives

  wm.restore(win.id);
  expect(win.state).toBe('normal');
  expect(win.frame.style.display).not.toBe('none');

  wm.dispose(); desktop.remove();
});

test('taskbar reflects open windows and their titles', async () => {
  const desktop = setupDesktop();
  const taskbar = document.createElement('div');
  document.body.appendChild(taskbar);
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'Alpha', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, taskbar, kernel: kernel as any, apps });

  await wm.open('a');
  const items = taskbar.querySelectorAll('[data-role="taskbar-item"]');
  expect(items.length).toBe(1);
  expect(items[0].textContent).toContain('Alpha');

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('renderTaskbar never clobbers sibling nodes it did not create (Bug B regression)', async () => {
  const desktop = setupDesktop();
  const taskbar = document.createElement('div');
  document.body.appendChild(taskbar);
  // A host-owned launcher lives in the taskbar (mirrors example-desktop main.ts).
  const launcher = document.createElement('div');
  launcher.dataset.role = 'launcher';
  taskbar.appendChild(launcher);

  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'Alpha', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, taskbar, kernel: kernel as any, apps });

  await wm.open('a');            // triggers #renderTaskbar via focus() + open()
  // The launcher must still be present AND a running-item must have been rendered.
  expect(taskbar.querySelector('[data-role="launcher"]')).toBe(launcher);
  expect(taskbar.querySelectorAll('[data-role="taskbar-item"]').length).toBe(1);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('running chips show the app icon and mark the focused window', async () => {
  const desktop = setupDesktop();
  const taskbar = document.createElement('div');
  document.body.appendChild(taskbar);
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'Alpha', icon: '🅰️', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, taskbar, kernel: kernel as any, apps });

  const win = await wm.open('a');
  const chip = taskbar.querySelector('[data-role="taskbar-item"]') as HTMLButtonElement;
  expect(chip.textContent).toContain('🅰️');
  expect(chip.dataset.focused).toBe('true'); // newest window is focused

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('focused chip marks the top VISIBLE window even when a higher-z window is minimized', async () => {
  const desktop = setupDesktop();
  const taskbar = document.createElement('div');
  document.body.appendChild(taskbar);
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'Alpha', defaultSize: [200, 150], mount: () => {} });
  apps.register({ name: 'b', title: 'Beta', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, taskbar, kernel: kernel as any, apps });

  const a = await wm.open('a');
  const b = await wm.open('b'); // b opened last → highest z
  wm.minimize(b.id);            // the highest-z window is now minimized

  const chipA = taskbar.querySelector(`[data-role="taskbar-item"][data-id="${a.id}"]`) as HTMLButtonElement;
  const chipB = taskbar.querySelector(`[data-role="taskbar-item"][data-id="${b.id}"]`) as HTMLButtonElement;
  // The visible window (a) must be marked focused; the minimized one (b) must not.
  expect(chipA.dataset.focused).toBe('true');
  expect(chipB.dataset.focused).toBeUndefined();

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('dragging a window titlebar across a live iframe still tracks the pointer (H2 — pointer shield)', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  // A live iframe sitting in the desktop, overlapping the drag path. Without the
  // pointer shield (body.mithic-wm-dragging iframe { pointer-events:none }) a real
  // pointer crossing it would be swallowed by the iframe and the drag would stall.
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:absolute;left:200px;top:150px;width:400px;height:300px;border:0;';
  iframe.srcdoc = '<!doctype html><html><body style="margin:0;height:100%"></body></html>';
  desktop.appendChild(iframe);

  const win = await wm.open('a');
  const titlebar = win.frame.querySelector('[data-role="titlebar"]') as HTMLElement;
  expect(titlebar).not.toBeNull();

  const startX = 100, startY = 60;
  const x0 = win.geometry.x, y0 = win.geometry.y;

  // Begin the drag on the titlebar.
  titlebar.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, pointerId: 1, bubbles: true }));
  // The shield must be on so the (real) iframe is neutralized for the gesture.
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);
  // The shield CSS actually applies to the iframe (pointer-events:none).
  expect(getComputedStyle(iframe).pointerEvents).toBe('none');

  // Move the pointer along a path that crosses the iframe region (200..600, 150..450).
  const path: Array<[number, number]> = [[250, 200], [400, 300], [550, 420]];
  for (const [cx, cy] of path) {
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: cx, clientY: cy, pointerId: 1, bubbles: true }));
  }

  // Geometry tracked the LAST move: origin + (lastClient - start).
  const [lx, ly] = path.at(-1)!;
  expect(win.geometry.x).toBe(x0 + (lx - startX));
  expect(win.geometry.y).toBe(y0 + (ly - startY));
  expect(win.frame.style.transform).toBe(`translate3d(${win.geometry.x}px, ${win.geometry.y}px, 0px)`);

  document.dispatchEvent(new PointerEvent('pointerup', { clientX: lx, clientY: ly, pointerId: 1, bubbles: true }));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(false);

  iframe.remove();
  wm.dispose(); desktop.remove();
});

test('clicking titlebar chrome buttons drives the window (Bug A regression)', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [300, 200], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });
  const win = await wm.open('a');

  const closeBtn = win.frame.querySelector('button:nth-of-type(3)') as HTMLButtonElement;
  const minBtn = win.frame.querySelector('button:nth-of-type(1)') as HTMLButtonElement;

  // A pointerdown on a chrome button must NOT arm the drag shield (else capture steals the click).
  minBtn.dispatchEvent(new PointerEvent('pointerdown', { clientX: 1, clientY: 1, pointerId: 1, bubbles: true }));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(false);
  expect(win.state).toBe('normal');

  // The wired click handlers reach the WM: a click on minimize minimizes, on close removes.
  minBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(win.state).toBe('minimized');

  closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(desktop.querySelector('[data-role="window"]')).toBeNull();
  expect(wm.windows.length).toBe(0);

  wm.dispose(); desktop.remove();
});

test('toggleMaximize fills the desktop, then restores the original geometry', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [400, 300], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const win = await wm.open('a');
  const original = { ...win.geometry };
  expect(win.state).toBe('normal');

  // Maximize: state flips and geometry becomes the full desktop bounds.
  wm.toggleMaximize(win.id);
  expect(win.state).toBe('maximized');
  expect(win.geometry).toEqual({ x: 0, y: 0, w: desktop.clientWidth, h: desktop.clientHeight });
  // Geometry is reflected onto the frame (transform + size).
  expect(win.frame.style.transform).toBe('translate3d(0px, 0px, 0px)');
  expect(win.frame.style.width).toBe(`${desktop.clientWidth}px`);
  expect(win.frame.style.height).toBe(`${desktop.clientHeight}px`);

  // Restore: back to 'normal' and the exact original rect.
  wm.toggleMaximize(win.id);
  expect(win.state).toBe('normal');
  expect(win.geometry).toEqual(original);
  expect(win.frame.style.transform).toBe(`translate3d(${original.x}px, ${original.y}px, 0px)`);
  expect(win.frame.style.width).toBe(`${original.w}px`);

  wm.dispose(); desktop.remove();
});

test('maximize then close cleans up the frame and tracked window', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [300, 200], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const win = await wm.open('a');
  wm.toggleMaximize(win.id);
  expect(win.state).toBe('maximized');

  wm.close(win.id);
  expect(desktop.querySelector('[data-role="window"]')).toBeNull();
  expect(wm.windows.length).toBe(0);

  wm.dispose(); desktop.remove();
});

test('resize-handle drag grows the window geometry and updates the frame size', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [400, 300], resizable: true, mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const win = await wm.open('a');
  const handle = win.frame.querySelector('[data-role="resize"]') as HTMLElement;
  expect(handle).not.toBeNull();
  const w0 = win.geometry.w, h0 = win.geometry.h;

  const startX = 500, startY = 400, dx = 120, dy = 80;
  handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, pointerId: 1, bubbles: true }));
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: startX + dx, clientY: startY + dy, pointerId: 1, bubbles: true }));

  expect(win.geometry.w).toBe(w0 + dx);
  expect(win.geometry.h).toBe(h0 + dy);
  expect(win.frame.style.width).toBe(`${w0 + dx}px`);
  expect(win.frame.style.height).toBe(`${h0 + dy}px`);

  document.dispatchEvent(new PointerEvent('pointerup', { clientX: startX + dx, clientY: startY + dy, pointerId: 1, bubbles: true }));
  wm.dispose(); desktop.remove();
});

test('focus bridge: clicking inside a lower window\'s iframe raises it above the other (§5.3(4))', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  // Two tier-1 windows; we inject an iframe into the lower window's content to
  // stand in for a tier-2 guest (no real Kernel needed — the bridge only reads
  // document.activeElement, which we drive directly).
  apps.register({ name: 'a', title: 'A', defaultSize: [300, 200], mount: () => {} });
  apps.register({ name: 'b', title: 'B', defaultSize: [300, 200], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const a = await wm.open('a');
  const b = await wm.open('b');
  // b opened last → on top.
  expect(b.z).toBeGreaterThan(a.z);

  // Put a focusable iframe inside a's content (the lower window).
  const iframe = document.createElement('iframe');
  iframe.tabIndex = -1;
  iframe.style.cssText = 'width:100%;height:100%;border:0;';
  a.content.appendChild(iframe);

  // Simulate the cross-sandbox focus: the iframe becomes activeElement and the
  // top window blurs. The WM's blur handler must raise a above b.
  iframe.focus();
  window.dispatchEvent(new Event('blur'));
  await new Promise((r) => setTimeout(r, 0)); // let the queued microtask run

  expect(a.z).toBeGreaterThan(b.z);

  wm.dispose(); desktop.remove();
});

test('focus bridge ignores a blur when activeElement is not a tracked iframe', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [300, 200], mount: () => {} });
  apps.register({ name: 'b', title: 'B', defaultSize: [300, 200], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const a = await wm.open('a');
  const b = await wm.open('b');
  const zB = b.z;

  // An iframe that is NOT inside any tracked window's content.
  const stray = document.createElement('iframe');
  stray.tabIndex = -1;
  document.body.appendChild(stray);
  stray.focus();
  window.dispatchEvent(new Event('blur'));
  await new Promise((r) => setTimeout(r, 0));

  // No tracked iframe matched → z-order unchanged; b stays on top.
  expect(b.z).toBe(zB);
  expect(b.z).toBeGreaterThan(a.z);

  stray.remove();
  wm.dispose(); desktop.remove();
});

import { expect, test, vi } from 'vitest';
import { WindowManager } from './window-manager.ts';
import { AppRegistry } from './app-registry.ts';
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

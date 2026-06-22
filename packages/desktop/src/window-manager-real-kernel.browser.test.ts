/**
 * H1 [TEST-GAP]: minimize must NOT reload or kill a tier-2 guest.
 *
 * Unlike the fake-kernel tests, this opens a REAL tier-2 app: a Kernel +
 * IframeRuntime spawns an inline guest into the window's content container
 * (`display: 'window'`). The guest renders a marker element and STAYS ALIVE
 * (never calls exit), so the WM's auto-close `wait()` handler does not fire.
 *
 * We capture the live iframe element and the window's pid, minimize + restore,
 * and assert the SAME iframe is still connected, the pid is unchanged, and the
 * frame toggled display:none -> visible. This proves minimize is a pure
 * display toggle (the frame is never reparented), so the guest survives.
 *
 * Guest-import strategy mirrors the iframe/image-viewer browser tests: the guest
 * runs in an opaque origin and cannot import @mithic/*, so a minimal inline
 * createGuest is embedded as a self-contained code string.
 */
import { expect, test } from 'vitest';
import { Kernel } from '@mithic/kernel';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { WindowManager } from './window-manager.ts';
import { AppRegistry } from './app-registry.ts';

// Minimal inline guest runtime (createGuest + credit-based portToWritable),
// mirroring @mithic/guest-runtime which the opaque-origin iframe cannot import.
const INLINE_GUEST_RUNTIME = /* js */`
function portToWritable(port) {
  port.start?.();
  let credit = 0; const waiters = [];
  port.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === 'credit') {
      credit += m.bytes;
      while (waiters.length && credit >= waiters[0].needed) waiters.shift().resolve();
    }
  };
  async function send(chunk) {
    if (credit < chunk.byteLength) await new Promise(r => waiters.push({ needed: chunk.byteLength, resolve: r }));
    credit -= chunk.byteLength;
    port.postMessage({ type: 'data', chunk });
  }
  return new WritableStream({
    write(chunk) { return send(chunk); },
    close() { port.postMessage({ type: 'end' }); port.close(); },
    abort() { port.postMessage({ type: 'error', code: 'EPIPE' }); port.close(); },
  });
}
function createGuest({ control, init, preopenPorts = {} }) {
  const signalListeners = [];
  control.start?.();
  control.onmessage = (e) => {
    const msg = e.data;
    if (msg && typeof msg === 'object' && msg.event === 'signal') {
      const p = msg.payload || {};
      for (const cb of signalListeners) cb(p.signal || '', p.extra);
    }
  };
  const stdoutPort = preopenPorts[1];
  const stdout = stdoutPort ? portToWritable(stdoutPort) : new WritableStream();
  return {
    pid: init.pid, args: init.args, env: init.env, cwd: init.cwd, stdout,
    onSignal(cb) { signalListeners.push(cb); },
    exit(code) { control.postMessage({ type: 'exit', code }); control.close(); },
  };
}
`;

// A guest that renders a marker into its DOM, reports 'ready' on stdout, then
// STAYS ALIVE (resolves only when SIGTERM'd) — exactly like a real GUI app.
const GUEST_BODY = /* js */`
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  const enc = new TextEncoder();
  const marker = document.createElement('div');
  marker.id = 'live-marker';
  marker.textContent = 'alive';
  document.body.appendChild(marker);
  await w.write(enc.encode('ready\\n'));
  // Stay alive until terminated; do not exit on our own.
  await new Promise((resolve) => g.onSignal(() => resolve()));
  await w.close().catch(() => {});
  g.exit(0);
};
`;

function setupDesktop(): HTMLElement {
  const desktop = document.createElement('div');
  desktop.style.cssText = 'position:relative;width:1000px;height:700px;';
  document.body.appendChild(desktop);
  return desktop;
}

test('minimize/restore preserves a live tier-2 guest iframe and pid (H1)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new IframeRuntime(), vfs });

  const desktop = setupDesktop();
  const apps = new AppRegistry();
  apps.register({
    name: 'viewer',
    title: 'Viewer',
    defaultSize: [400, 300],
    entry: INLINE_GUEST_RUNTIME + GUEST_BODY,
    capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }],
  });
  const wm = new WindowManager({ desktop, kernel, apps });

  const win = await wm.open('viewer');
  expect(win.pid).toBeGreaterThan(0);
  const pidBefore = win.pid;

  // Wait for the runtime to mount the guest iframe into the window content.
  let iframe: HTMLIFrameElement | null = null;
  for (let i = 0; i < 100 && !iframe; i++) {
    iframe = win.content.querySelector('iframe');
    if (!iframe) await new Promise((r) => setTimeout(r, 20));
  }
  expect(iframe).not.toBeNull();
  expect(iframe!.isConnected).toBe(true);
  expect(win.frame.style.display).not.toBe('none');

  // Minimize: frame goes display:none but the iframe element must NOT be removed
  // or reparented (which would reload/kill the guest).
  wm.minimize(win.id);
  expect(win.state).toBe('minimized');
  expect(win.frame.style.display).toBe('none');
  expect(win.content.querySelector('iframe')).toBe(iframe); // same element
  expect(iframe!.isConnected).toBe(true);
  expect(win.pid).toBe(pidBefore);

  // Restore: frame becomes visible again; still the SAME iframe + pid.
  wm.restore(win.id);
  expect(win.state).toBe('normal');
  expect(win.frame.style.display).not.toBe('none');
  expect(win.content.querySelector('iframe')).toBe(iframe);
  expect(iframe!.isConnected).toBe(true);
  expect(win.pid).toBe(pidBefore);

  // Cleanup: closing SIGTERMs the guest (which resolves and exits).
  wm.dispose();
  desktop.remove();
}, 30000);

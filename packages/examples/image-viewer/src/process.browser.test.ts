/**
 * Browser test for the image-viewer GUI process (Group P.1), in real Chromium.
 *
 * Strategy (opaque-origin iframe):
 *   The iframe runs `sandbox="allow-scripts"` with NO `allow-same-origin`, so it
 *   cannot import `@mithic/*` from the dev server, and the host page cannot reach
 *   into its DOM cross-origin. We therefore:
 *     1. Embed a minimal inline `createGuest` + the image-viewer render logic as a
 *        self-contained guest code string (the same technique the kernel/iframe
 *        browser tests use). The render logic mirrors `renderImageViewer` in
 *        `process.ts`.
 *     2. Spawn it via Kernel + IframeRuntime in `display: 'inline'`.
 *     3. Have the GUEST self-drive a synthetic file drop on its own drop-zone and
 *        SELF-REPORT on stdout (`ready`, then `img-rendered:<objectURL>`).
 *     4. Assert on the captured stdout markers AND that a visible (inline) iframe
 *        was mounted into the DOM.
 *
 * This proves the spec outcome — "an <img> is rendered inside the iframe and a
 * ready marker emitted" — within the cross-origin constraint: the guest reports
 * that it created the <img>, set its src to an object URL, and the drop handler
 * fired, all inside its own real DOM.
 */
import { expect, test } from 'vitest';
import { Kernel } from '@mithic/kernel';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

// Inline guest runtime: minimal createGuest + credit-based portToWritable,
// mirroring @mithic/guest-runtime (cannot be imported in the opaque-origin iframe).
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

// Inline mirror of renderImageViewer() from process.ts.
const GUEST_BODY = /* js */`
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  const enc = new TextEncoder();
  const emit = (line) => w.write(enc.encode(line + '\\n'));

  const dropZone = document.createElement('div');
  dropZone.id = 'drop-zone';
  dropZone.textContent = 'Drop an image here';
  const img = document.createElement('img');
  img.id = 'preview';
  img.style.display = 'none';
  const loadFile = (file) => {
    const url = URL.createObjectURL(file);
    img.src = url;
    img.style.display = 'block';
    dropZone.textContent = file.name;
    return url;
  };
  dropZone.addEventListener('dragover', (e) => e.preventDefault());
  let onSettled;
  const loaded = new Promise((res) => { onSettled = res; });
  img.addEventListener('load', () => onSettled(img.naturalWidth));
  img.addEventListener('error', () => onSettled(0));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) {
      const url = loadFile(file);
      // Report what was actually rendered: the <img> tag, its src scheme, and the file.
      emit('img-rendered:' + url + '|tag=' + img.tagName + '|src=' + (img.getAttribute('src') || '').slice(0, 5) + '|name=' + file.name);
    }
  });
  document.body.appendChild(dropZone);
  document.body.appendChild(img);

  await emit('ready');

  // Self-drive a synthetic PNG drop: a 1x1 transparent PNG.
  const pngBytes = Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  ), (c) => c.charCodeAt(0));
  const file = new File([pngBytes], 'pixel.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: dt });
  dropZone.dispatchEvent(drop);

  // Wait for the <img> 'load' event (canonical paint signal), then emit img-painted with
  // its naturalWidth BEFORE closing stdout — a nonzero width proves the blob actually
  // decoded/painted under the new CSP (a CSP-blocked blob fires 'error' → width 0).
  // Emitting inline (not from the listener) keeps the marker ordered ahead of w.close().
  const nw = await Promise.race([loaded, new Promise((r) => setTimeout(() => r(img.naturalWidth), 2000))]);
  await emit('img-painted:' + nw);

  await w.close().catch(() => {});
  g.exit(0);
};
`;

test('image-viewer: renders <img> on drop and emits ready + img-rendered markers', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const runtime = new IframeRuntime();
  const kernel = new Kernel({ runtime, vfs });

  const before = document.querySelectorAll('iframe').length;

  const code = INLINE_GUEST_RUNTIME + GUEST_BODY;
  const { pid, stdout } = await kernel.spawn(code, {
    args: ['image-viewer'],
    capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }],
    captureStdout: true,
    display: { mode: 'inline', width: 800, height: 600 },
  });

  const result = await kernel.wait(pid);
  expect(result.code).toBe(0);

  const out = new TextDecoder().decode(await stdout!);
  // The process self-reported its DOM work.
  expect(out).toContain('ready');
  expect(out).toMatch(/img-rendered:blob:/);
  expect(out).toMatch(/img-painted:[1-9]/); // naturalWidth > 0 — the blob actually decoded under the new CSP
  expect(out).toContain('tag=IMG');
  expect(out).toContain('name=pixel.png');

  // A visible (inline) iframe was mounted for the GUI process.
  const after = document.querySelectorAll('iframe').length;
  expect(after).toBeGreaterThan(before);
}, 20000);

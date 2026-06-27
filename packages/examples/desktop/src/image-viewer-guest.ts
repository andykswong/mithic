/* eslint-disable @stylistic/indent -- embedded guest JS string */
/** Inline image-viewer guest (opaque-origin iframe cannot import @mithic/*). */
export const IMAGE_VIEWER_GUEST = /* js */`
function portToWritable(port) {
  port.start?.();
  let credit = 0; const waiters = [];
  port.onmessage = (e) => { const m = e.data; if (m && m.type === 'credit') { credit += m.bytes; while (waiters.length && credit >= waiters[0].needed) waiters.shift().resolve(); } };
  async function send(chunk) { if (credit < chunk.byteLength) await new Promise(r => waiters.push({ needed: chunk.byteLength, resolve: r })); credit -= chunk.byteLength; port.postMessage({ type: 'data', chunk }); }
  return new WritableStream({ write(c) { return send(c); }, close() { port.postMessage({ type: 'end' }); port.close(); }, abort() { port.postMessage({ type: 'error', code: 'EPIPE' }); port.close(); } });
}
function createGuest({ control, init, preopenPorts = {} }) {
  const signalListeners = [];
  control.start?.();
  control.onmessage = (e) => { const m = e.data; if (m && typeof m === 'object' && m.event === 'signal') { const p = m.payload || {}; for (const cb of signalListeners) cb(p.signal || '', p.extra); } };
  const stdoutPort = preopenPorts[1];
  const stdout = stdoutPort ? portToWritable(stdoutPort) : new WritableStream();
  return { pid: init.pid, args: init.args, env: init.env, cwd: init.cwd, stdout, onSignal(cb) { signalListeners.push(cb); }, exit(code) { control.postMessage({ type: 'exit', code }); control.close(); } };
}
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  const enc = new TextEncoder();
  // Display-awareness: the host threads the boot DisplayInfo here. An explicit
  // available:false (server/Node host, or spawned hidden) means there is NO GUI
  // surface, so run headless — never touch the DOM — then await a signal + exit.
  const display = boot.init && boot.init.display;
  if (display && display.available === false) {
    await w.write(enc.encode('headless\\n'));
    await new Promise((resolve) => g.onSignal(() => resolve()));
    await w.close().catch(() => {});
    g.exit(0);
    return;
  }
  const dz = document.createElement('div');
  dz.id = 'drop-zone'; dz.textContent = 'Drop an image here';
  dz.style.cssText = 'border:2px dashed #888;border-radius:8px;padding:24px;text-align:center;font:14px sans-serif;color:#ccc;margin:12px;';
  const img = document.createElement('img'); img.id = 'preview'; img.style.maxWidth = '100%'; img.style.display = 'none';
  dz.addEventListener('dragover', (e) => e.preventDefault());
  dz.addEventListener('drop', (e) => { e.preventDefault(); const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (file) { const url = URL.createObjectURL(file); img.src = url; img.style.display = 'block'; dz.textContent = file.name; w.write(enc.encode('img-rendered:' + url + '\\n')); } });
  document.body.style.cssText = 'margin:0;background:#1e1e2e;color:#ccc;';
  document.body.appendChild(dz); document.body.appendChild(img);
  await w.write(enc.encode('ready\\n'));
  await new Promise((resolve) => g.onSignal(() => resolve()));
  await w.close().catch(() => {});
  g.exit(0);
};
`;
/* eslint-enable @stylistic/indent */

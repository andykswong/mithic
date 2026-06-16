/**
 * `@mithic/example-notebook` — an xterm.js shell notebook frontend.
 *
 * This is the capstone integration: a browser page that boots an Mithic
 * {@link Kernel}, renders an xterm.js terminal, runs the `@mithic/shell-js`
 * shell wired to that terminal, and renders GUI processes (the image-viewer)
 * inline as placed iframes.
 *
 * Wiring (xterm <-> shell):
 *   - Keystrokes from xterm's `onData` accumulate into a line buffer; Enter
 *     submits the line.
 *   - The submitted line is fed to the shell-js {@link Executor} (the real shell
 *     interpreter) whose `onStdout`/`onStderr` sinks write straight back into the
 *     terminal. `echo hi | cat` therefore round-trips entirely through the
 *     shell's in-process builtin pipeline.
 *   - A notebook-level `open-image` command spawns the image-viewer GUI process
 *     via `Kernel.spawn(..., { display: 'inline' })`; the GUI-capable
 *     {@link IframeRuntime} mounts the resulting iframe into the results pane.
 *
 * DEFERRED — shell-driven external spawn:
 *   The shell-js shell can only run builtins in-process; spawning an EXTERNAL
 *   process (so the SHELL itself launches the image-viewer) needs a
 *   `process/spawn` kernel syscall that does not exist yet. Until it lands, the
 *   notebook intercepts `open-image` at the frontend and spawns the GUI directly
 *   via the kernel — which still proves inline GUI rendering end-to-end. See the
 *   shell-js executor header (KNOWN LIMITATIONS) for the syscall status.
 */
import { Terminal } from '@xterm/xterm';
import { Kernel } from '@mithic/kernel';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { Executor, parse } from '@mithic/shell-js';
import type { KernelClient } from '@mithic/shell-js';

/* eslint-disable @stylistic/indent -- embedded guest JS string */
/** Inline guest source for the image-viewer (opaque-origin iframe cannot import @mithic/*). */
export const IMAGE_VIEWER_GUEST = /* js */`
function portToWritable(port) {
  port.start?.();
  let credit = 0; const waiters = [];
  port.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === 'credit') { credit += m.bytes; while (waiters.length && credit >= waiters[0].needed) waiters.shift().resolve(); }
  };
  async function send(chunk) {
    if (credit < chunk.byteLength) await new Promise(r => waiters.push({ needed: chunk.byteLength, resolve: r }));
    credit -= chunk.byteLength; port.postMessage({ type: 'data', chunk });
  }
  return new WritableStream({
    write(c) { return send(c); },
    close() { port.postMessage({ type: 'end' }); port.close(); },
    abort() { port.postMessage({ type: 'error', code: 'EPIPE' }); port.close(); },
  });
}
function createGuest({ control, init, preopenPorts = {} }) {
  const signalListeners = [];
  control.start?.();
  control.onmessage = (e) => {
    const m = e.data;
    if (m && typeof m === 'object' && m.event === 'signal') {
      const p = m.payload || {}; for (const cb of signalListeners) cb(p.signal || '', p.extra);
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
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  const enc = new TextEncoder();
  const dz = document.createElement('div');
  dz.id = 'drop-zone';
  dz.textContent = 'Drop an image here';
  dz.style.cssText = 'border:2px dashed #888;border-radius:8px;padding:24px;text-align:center;font:14px sans-serif;';
  const img = document.createElement('img');
  img.id = 'preview'; img.style.maxWidth = '100%'; img.style.display = 'none';
  dz.addEventListener('dragover', (e) => e.preventDefault());
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) { const url = URL.createObjectURL(file); img.src = url; img.style.display = 'block'; dz.textContent = file.name; w.write(enc.encode('img-rendered:' + url + '\\n')); }
  });
  document.body.appendChild(dz); document.body.appendChild(img);
  await w.write(enc.encode('ready\\n'));
  await new Promise((resolve) => g.onSignal(() => resolve()));
  await w.close().catch(() => {});
  g.exit(0);
};
`;
/* eslint-enable @stylistic/indent */

export interface Notebook {
  terminal: Terminal;
  kernel: Kernel;
  /** Submit a full command line (without trailing newline) as if typed + Enter. */
  submitLine(line: string): Promise<void>;
  dispose(): void;
}

/** A KernelClient stub — the shell runs builtins in-process (no external spawn yet). */
const NO_SPAWN_CLIENT: KernelClient = {
  async spawn() {
    throw Object.assign(new Error('process/spawn unsupported'), { code: 'ENOSYS' });
  },
  async wait(pid: number) {
    return { pid, code: 0 };
  },
};

/**
 * Boot the notebook: kernel + iframe runtime, an xterm terminal mounted into
 * `terminalEl`, and a results pane (`resultsEl`) where inline GUI iframes land.
 */
export async function bootNotebook(
  terminalEl: HTMLElement,
  resultsEl: HTMLElement,
): Promise<Notebook> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const runtime = new IframeRuntime({ container: resultsEl });
  const kernel = new Kernel({ runtime, vfs });

  const terminal = new Terminal({ convertEol: true, cols: 80, rows: 24 });
  terminal.open(terminalEl);

  const prompt = (): void => terminal.write('$ ');
  terminal.write('mithic notebook — type a command\r\n');
  prompt();

  const env: Record<string, string> = { HOME: '/', PWD: '/' };

  // Spawn the image-viewer GUI process inline and wait for its 'ready' marker.
  const openImage = async (): Promise<void> => {
    const { pid } = await kernel.spawn(IMAGE_VIEWER_GUEST, {
      args: ['image-viewer'],
      capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }],
      display: { mode: 'inline', width: 400, height: 300, title: 'image-viewer' },
    });
    terminal.write(`[notebook] spawned image-viewer pid=${pid}\r\n`);
  };

  const submitLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) { prompt(); return; }
    // Notebook-level intercept for the GUI demo (shell-driven spawn deferred).
    if (trimmed === 'open-image') {
      await openImage();
      prompt();
      return;
    }
    const executor = new Executor(NO_SPAWN_CLIENT, { cwd: '/', env }, {
      onStdout: (s) => terminal.write(s),
      onStderr: (s) => terminal.write(s),
    });
    try {
      await executor.run(parse(trimmed));
    } catch (err) {
      terminal.write(`shell: ${(err as Error).message}\r\n`);
    }
    prompt();
  };

  // Keystroke -> line buffer; Enter submits.
  let lineBuf = '';
  const onData = terminal.onData((data: string) => {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        terminal.write('\r\n');
        const line = lineBuf;
        lineBuf = '';
        void submitLine(line);
      } else if (ch === '\x7f') {
        if (lineBuf.length > 0) { lineBuf = lineBuf.slice(0, -1); terminal.write('\b \b'); }
      } else {
        lineBuf += ch;
        terminal.write(ch);
      }
    }
  });

  return {
    terminal,
    kernel,
    submitLine,
    dispose() {
      onData.dispose();
      terminal.dispose();
    },
  };
}

// Auto-boot when loaded as the page entry (index.html).
if (typeof document !== 'undefined' && document.getElementById('terminal')) {
  const termEl = document.getElementById('terminal');
  const resultsEl = document.getElementById('results');
  if (termEl && resultsEl) {
    void bootNotebook(termEl, resultsEl);
  }
}

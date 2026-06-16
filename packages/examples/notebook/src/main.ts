/**
 * `@mithic/example-notebook` — an xterm.js shell notebook frontend.
 *
 * This is the capstone integration: a browser page that boots a Mithic
 * {@link Kernel}, renders an xterm.js terminal running the `@mithic/shell` shell
 * wired to that terminal, runs the full `@mithic/coreutils` + `@mithic/jq` +
 * `@mithic/curl` suite as real sandboxed guest processes, AND renders GUI
 * processes (the image-viewer) inline as placed iframes in the results pane.
 *
 * Wiring (xterm <-> shell <-> kernel <-> commands):
 *   - Keystrokes from xterm's `onData` accumulate into a line buffer; Enter
 *     submits the line to the shell {@link Executor}, whose `onStdout`/`onStderr`
 *     sinks write straight back into the terminal.
 *   - The executor runs builtins in-process and forks externals via a real
 *     {@link KernelClient} backed by `kernel.spawn` / `kernel.runPipeline`. So
 *     `ls`, `cat`, `echo hi | grep h`, `sort | uniq`, `seq | awk`, and `jq` all
 *     run the REAL command guests end-to-end (see commands.ts: each guest is
 *     bundled by Vite and run in-process by {@link InProcessCommandLauncher},
 *     keyed by a `command:<name>` sentinel from the composed resolver).
 *   - Redirects and glob go through an {@link FsClient} over the seeded host VFS
 *     (a MemoryFs), so `echo hi > /tmp/x; cat /tmp/x` and `cat *.txt` work.
 *   - The notebook's distinctive feature: a `open-image` command spawns the
 *     image-viewer GUI process via `Kernel.spawn(..., { display: 'inline' })`;
 *     the GUI-capable {@link IframeRuntime} mounts the resulting iframe into the
 *     results pane.
 */
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { Kernel } from '@mithic/kernel';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import { Executor, parse } from '@mithic/shell';
import type {
  KernelClient,
  FsClient,
  SpawnParams,
  SpawnHandle,
  PipelineStageParams,
  PipelineRunResult,
} from '@mithic/shell';
import type { Capability } from '@mithic/protocol';
import { createCommandSuite } from './commands.ts';

/** Capabilities granted to every spawned command: read+write the whole VFS, and HTTP for curl. */
const CHILD_CAPABILITIES: Capability[] = [
  { type: 'fs', paths: ['/'], operations: ['read', 'write'] },
  { type: 'net', origins: ['*'] },
];

/** Demo files seeded into the VFS so a fresh notebook has something to explore. */
const SEED_FILES: Record<string, string> = {
  '/welcome.txt': 'Welcome to the Mithic notebook!\nEverything here runs sandboxed in your browser.\n',
  '/fruits.txt': 'banana\napple\ncherry\napple\nbanana\napple\n',
  '/data.json': '{"name":"mithic","stars":42,"tags":["wasm","shell","vfs"]}\n',
  '/numbers.txt': '3\n1\n4\n1\n5\n9\n2\n6\n',
  '/tmp/.keep': '',
};

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

/**
 * A {@link KernelClient} over the real {@link Kernel}. The shell executor calls
 * this to fork externals; we delegate to `kernel.spawn` / `kernel.runPipeline`
 * and grant each child the standard {@link CHILD_CAPABILITIES}. The executor has
 * already resolved each command name to its `command:<name>` sentinel URL
 * (`params.code`), which the kernel's {@link InProcessCommandLauncher} runs.
 */
function makeKernelClient(kernel: Kernel): KernelClient {
  const enc = new TextEncoder();
  return {
    async spawn(params: SpawnParams): Promise<SpawnHandle> {
      const { pid, stdout } = await kernel.spawn(params.code, {
        args: params.args,
        env: params.env,
        cwd: params.cwd,
        capabilities: CHILD_CAPABILITIES,
        captureStdout: params.captureStdout,
        captureStderr: params.captureStderr,
        stdinData: params.stdinData !== undefined ? enc.encode(params.stdinData) : undefined,
      });
      return { pid, stdout };
    },
    async wait(pid: number) {
      const { code } = await kernel.wait(pid);
      return { pid, code };
    },
    async runPipeline(stages: PipelineStageParams[]): Promise<PipelineRunResult> {
      const result = await kernel.runPipeline(
        stages.map((s, i) => ({
          code: s.code,
          args: s.args,
          env: s.env,
          cwd: s.cwd,
          capabilities: CHILD_CAPABILITIES,
          captureStdout: i === stages.length - 1 ? s.captureStdout : false,
          captureStderr: s.captureStderr,
          stdinData: i === 0 && s.stdinData !== undefined ? enc.encode(s.stdinData) : undefined,
        })),
      );
      return {
        pids: result.pids,
        exitCodes: result.exitCodes,
        lastStdout: result.lastStdout,
        stderr: result.stderr,
      };
    },
  };
}

/**
 * An {@link FsClient} backed directly by a host VFS provider — for shell
 * redirects (`>`, `>>`, `<`) and glob/pathname expansion. Writes are buffered
 * per synthetic fd and flushed to the VFS on close.
 */
function makeFsClient(fs: FileSystemProvider): FsClient & { flush(): Promise<void> } {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  interface Open { path: string; data: string; write: boolean; append: boolean }
  const open = new Map<number, Open>();
  let nextFd = 1000;
  const pending: Array<Promise<unknown>> = [];

  const readFile = async (path: string): Promise<string> => {
    const h = (await fs.open(path, { read: true })) as FileHandle;
    const chunks: Uint8Array[] = [];
    let off = 0;
    for (;;) {
      const c = await fs.read(h, off, 65536);
      if (!c || c.byteLength === 0) break;
      chunks.push(new Uint8Array(c));
      off += c.byteLength;
    }
    await fs.close(h);
    let total = 0; for (const c of chunks) total += c.byteLength;
    const buf = new Uint8Array(total); let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
    return dec.decode(buf);
  };

  return {
    async flush() { await Promise.all(pending); },
    fsOpen(path, flags): number {
      const fd = nextFd++;
      open.set(fd, { path, data: '', write: !!flags.write, append: !!flags.append });
      return fd;
    },
    fsWrite(fd, data): void {
      const o = open.get(fd);
      if (o) o.data += data;
    },
    async fsRead(fd): Promise<string> {
      const o = open.get(fd);
      if (!o) return '';
      return readFile(o.path);
    },
    fsClose(fd): void {
      const o = open.get(fd);
      open.delete(fd);
      if (o && (o.write || o.append)) {
        pending.push((async () => {
          const h = (await fs.open(o.path, {
            write: !o.append, append: o.append, create: true, truncate: !o.append,
          })) as FileHandle;
          await fs.write(h, enc.encode(o.data), 0);
          await fs.close(h);
        })());
      }
    },
    async fsReaddir(path): Promise<string[]> {
      const entries = await fs.readdir(path);
      return entries.map((e) => e.name);
    },
    async fsStat(path): Promise<{ dir: boolean } | undefined> {
      try {
        const s = await fs.stat(path);
        return { dir: s.type === 'directory' };
      } catch { return undefined; }
    },
  };
}

/**
 * Boot the notebook: a kernel with the composed command suite over a seeded
 * MemoryFs and a GUI-capable {@link IframeRuntime}, an xterm terminal mounted
 * into `terminalEl`, and a results pane (`resultsEl`) where inline GUI iframes
 * land. The shell runs builtins + the real coreutils/jq/curl suite; `open-image`
 * spawns the image-viewer GUI inline.
 */
export async function bootNotebook(
  terminalEl: HTMLElement,
  resultsEl: HTMLElement,
): Promise<Notebook> {
  const suite = createCommandSuite();

  const memfs = new MemoryFsProvider({ files: SEED_FILES });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', memfs);

  const runtime = new IframeRuntime({ container: resultsEl });
  const kernel = new Kernel({
    runtime,
    vfs,
    resolveCommand: (name) => suite.resolve(name),
    launcher: suite.launcher,
  });

  const terminal = new Terminal({ convertEol: true, cols: 80, rows: 24 });
  terminal.open(terminalEl);

  const prompt = (): void => terminal.write('$ ');
  terminal.write('mithic notebook — type a command (try: ls, cat data.json | jq .tags, open-image)\r\n');
  prompt();

  const context = { cwd: '/', env: { HOME: '/', PWD: '/', PATH: '/bin', SHELL: 'mithic-sh' } as Record<string, string> };
  const kernelClient = makeKernelClient(kernel);
  const fsClient = makeFsClient(memfs);

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
    // Notebook-level intercept for the GUI demo: spawn the image-viewer inline.
    if (trimmed === 'open-image') {
      await openImage();
      prompt();
      return;
    }
    const executor = new Executor(kernelClient, context, {
      resolve: (name) => suite.resolve(name),
      fs: fsClient,
      onStdout: (s) => terminal.write(s),
      onStderr: (s) => terminal.write(s),
    });
    try {
      await executor.run(parse(trimmed));
      await fsClient.flush();
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

/**
 * `@mithic/example-shell` — a real interactive browser terminal.
 *
 * An xterm.js front-end drives the JS `@mithic/shell` interpreter, which runs in
 * the host page and forks external commands (the full `@mithic/coreutils` +
 * `@mithic/jq` + `@mithic/curl` suite) as sandboxed guest processes through an
 * `@mithic/kernel` {@link Kernel}. Everything runs identically in the browser, in
 * Node, and under vitest's Chromium.
 *
 * WIRING (xterm <-> shell <-> kernel <-> commands):
 *   - The xterm `Terminal` is the TTY. Keystrokes flow through a small line
 *     editor (backspace, Enter, Up/Down history, Ctrl+C) that accumulates a
 *     command line and, on Enter, hands it to the shell.
 *   - The shell {@link Executor} runs builtins in-process and dispatches
 *     externals via a {@link KernelClient} backed by the real kernel's
 *     `spawn` / `runPipeline` / `wait`. Its `onStdout`/`onStderr` sinks write
 *     straight back into the terminal.
 *   - `resolveCommand` is the COMPOSED coreutils + jq + curl registry
 *     ({@link createCommandSuite}); a name resolves to a `command:<name>`
 *     sentinel that the kernel's {@link InProcessCommandLauncher} runs in-process
 *     (see commands.ts for why URL-based Worker/iframe loading can't work in a
 *     browser). So `seq 1 5 | awk '{s+=$1}END{print s}'` and `echo '{"a":1}' |
 *     jq .a` run the REAL coreutils/jq guests end-to-end.
 *   - Redirects and glob go through an {@link FsClient} backed directly by the
 *     host VFS (a seeded MemoryFs), so `echo hi > /tmp/x; cat /tmp/x` and
 *     `cat *.txt` work.
 */
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Kernel } from '@mithic/kernel';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider, DeviceFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import { Executor, expandPrompt, parse } from '@mithic/shell';
import type {
  KernelClient,
  FsClient,
  SpawnParams,
  SpawnHandle,
  PipelineStageParams,
  PipelineRunResult,
} from '@mithic/shell';
import { createCommandSuite } from './commands.ts';
import { CHILD_CAPABILITIES, SEED_FILES, TERMINAL_CONFIG, getBashrc } from './config.ts';

export interface ShellApp {
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
  // runPipeline awaits + REAPS each stage, so record exit codes by pid here and
  // serve a later wait(pid) from the map (a second kernel.wait would find the
  // pid already reaped and report -1).
  const exitCodes = new Map<number, number>();
  return {
    async spawn(params: SpawnParams): Promise<SpawnHandle> {
      // D8: route a single command through runPipeline (one stage) so a
      // redirect-fed `fds[0]` stdin source is pipe-fed by the kernel — the same
      // path the pipeline uses. (kernel.spawn's SpawnInit has no fds wiring.)
      const result = await kernel.runPipeline([{
        code: params.code,
        args: params.args,
        env: params.env,
        cwd: params.cwd,
        capabilities: CHILD_CAPABILITIES,
        captureStdout: params.captureStdout,
        captureStderr: params.captureStderr,
        fds: params.fds,
      }]);
      exitCodes.set(result.pids[0], result.exitCodes[0] ?? 0);
      // Bug B: surface the child's captured stderr so a failing command's error
      // reaches the terminal (the executor drains this into its stderr sink).
      return { pid: result.pids[0], stdout: result.lastStdout, stderr: result.stderr[0] };
    },
    async wait(pid: number) {
      const recorded = exitCodes.get(pid);
      if (recorded !== undefined) return { pid, code: recorded };
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
          fds: i === 0 ? s.fds : undefined,
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
 * per synthetic fd and flushed to the VFS on close (mirroring the guest shell's
 * `makeFsClient`, but talking to the provider directly instead of via syscalls).
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
 * Boot the terminal app into `element`: a kernel with the composed command suite
 * over a seeded MemoryFs, an xterm.js terminal, and the interactive REPL loop.
 */
export async function bootShell(element: HTMLElement): Promise<ShellApp> {
  const suite = createCommandSuite();

  const memfs = new MemoryFsProvider({ files: SEED_FILES });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', memfs);
  // Mount the device tree so spawned commands can open `/dev/zero`, `/dev/random`,
  // `/dev/urandom`, and `/dev/null` (e.g. `head -c N /dev/urandom`). Without this
  // mount such paths fail with File not found and the command silently exits 1.
  await vfs.mount('/dev', new DeviceFsProvider());

  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    // The kernel's command resolver (for any guest-driven process/spawn) and the
    // launcher both route command names through the in-process suite.
    resolveCommand: (name) => suite.resolve(name),
    launcher: suite.launcher,
  });

  const terminal = new Terminal(TERMINAL_CONFIG);
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  try { fit.fit(); } catch { /* zero-size container in tests: ignore */ }

  const onResize = (): void => { try { fit.fit(); } catch { /* ignore */ } };
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

  // Shell state shared across command lines (cwd, env, vars persist in the REPL).
  // `interactive` enables bash history expansion (`!!`, `!n`) for the REPL.
  const context = { cwd: '/', env: { HOME: '/', PWD: '/', PATH: '/bin', SHELL: 'mithic-sh' } as Record<string, string>, interactive: true };
  const kernelClient = makeKernelClient(kernel);
  const fsClient = makeFsClient(memfs);

  // The prompt is computed from $PS1 each turn so it reflects cwd changes and the
  // PS1 the sourced .bashrc set; default to bash's `\w\$ ` until then.
  const prompt = (): void => terminal.write(expandPrompt(context.env.PS1 ?? '\\w\\$ ', context));

  // Run one command line through a fresh executor (sharing the persistent
  // context/env so `cd`, var assignments, etc. carry across lines).
  const runScriptLine = async (line: string): Promise<void> => {
    const executor = new Executor(kernelClient, context, {
      resolve: (name) => suite.resolve(name),
      fs: fsClient,
      onStdout: (s) => terminal.write(s),
      onStderr: (s) => terminal.write(s),
    });
    await executor.run(parse(line));
    await fsClient.flush();
  };

  // Boot: SOURCE the .bashrc through the real shell — its `echo -e` lines render
  // the ANSI/OSC-8 banner and `export PS1=…` sets the prompt — exactly as a login
  // shell would, instead of a hardcoded terminal.write(BANNER).
  try {
    await runScriptLine(getBashrc());
  } catch (err) {
    terminal.write(`shell: ${(err as Error).message}\r\n`);
  }
  prompt();

  const submitLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) { prompt(); return; }
    try {
      await runScriptLine(trimmed);
    } catch (err) {
      terminal.write(`shell: ${(err as Error).message}\r\n`);
    }
    prompt();
  };

  // ── line editor ──────────────────────────────────────────────────────────
  let lineBuf = '';
  const history: string[] = [];
  let histIndex = 0; // points one past the last entry (= "new line")
  let running = false;

  const replaceLine = (next: string): void => {
    // Erase current input, then write the replacement.
    if (lineBuf.length > 0) terminal.write('\b'.repeat(lineBuf.length) + ' '.repeat(lineBuf.length) + '\b'.repeat(lineBuf.length));
    lineBuf = next;
    terminal.write(next);
  };

  const onData = terminal.onData((data: string) => {
    if (running) return; // ignore input while a command is executing
    // Handle multi-byte escape sequences (arrow keys) first.
    if (data === '\x1b[A') { // Up
      if (history.length > 0 && histIndex > 0) { histIndex--; replaceLine(history[histIndex]); }
      return;
    }
    if (data === '\x1b[B') { // Down
      if (histIndex < history.length) {
        histIndex++;
        replaceLine(histIndex === history.length ? '' : history[histIndex]);
      }
      return;
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        terminal.write('\r\n');
        const line = lineBuf;
        lineBuf = '';
        if (line.trim().length > 0) { history.push(line); }
        histIndex = history.length;
        running = true;
        void submitLine(line).finally(() => { running = false; });
      } else if (ch === '\x7f' || ch === '\b') { // Backspace
        if (lineBuf.length > 0) { lineBuf = lineBuf.slice(0, -1); terminal.write('\b \b'); }
      } else if (ch === '\x03') { // Ctrl+C — cancel the current line
        terminal.write('^C\r\n');
        lineBuf = '';
        histIndex = history.length;
        prompt();
      } else if (ch >= ' ') {
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
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      terminal.dispose();
    },
  };
}

// Auto-boot when loaded as the page entry (index.html).
if (typeof document !== 'undefined') {
  const el = document.getElementById('terminal');
  if (el) void bootShell(el);
}

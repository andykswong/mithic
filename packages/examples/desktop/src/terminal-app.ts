import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Executor, parse } from '@mithic/shell';
import type { KernelClient, FsClient, SpawnParams, SpawnHandle, PipelineStageParams, PipelineRunResult } from '@mithic/shell';
import type { Kernel } from '@mithic/kernel';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import type { Capability } from '@mithic/protocol';
import type { WindowContext } from '@mithic/desktop';
import type { CommandSuite } from './commands.ts';

const CHILD_CAPABILITIES: Capability[] = [
  { type: 'fs', paths: ['/'], operations: ['read', 'write'] },
  { type: 'net', origins: ['*'] },
];

export interface TerminalDeps {
  kernel: Kernel;
  vfs: FileSystemProvider;
  suite: CommandSuite;
}

export interface TerminalHandle {
  terminal: Terminal;
  submitLine(line: string): Promise<void>;
  dispose(): void;
}

/** Mount an interactive shell terminal into a window's content element. */
export function mountTerminal(ctx: WindowContext, deps: TerminalDeps): TerminalHandle {
  const { kernel, vfs, suite } = deps;
  const terminal = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13,
    theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(ctx.content);
  try { fit.fit(); } catch { /* zero-size in tests */ }

  // Refit on native resize (the iframe/content fills the window; resizing the
  // window frame fires resize here for free).
  const onResize = (): void => { try { fit.fit(); } catch { /* ignore */ } };
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

  const context = { cwd: '/', env: { HOME: '/', PWD: '/', PATH: '/bin', SHELL: 'mithic-sh' } as Record<string, string> };
  const kernelClient = makeKernelClient(kernel);
  const fsClient = makeFsClient(vfs);

  const PROMPT = '\x1b[1;32m$\x1b[0m ';
  const prompt = (): void => terminal.write(PROMPT);
  terminal.write('mithic OS terminal\r\n');
  prompt();

  const submitLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) { prompt(); return; }
    const executor = new Executor(kernelClient, context, {
      resolve: (name) => suite.resolve(name),
      fs: fsClient,
      onStdout: (s) => terminal.write(s),
      onStderr: (s) => terminal.write(s),
    });
    try { await executor.run(parse(trimmed)); await fsClient.flush(); }
    catch (err) { terminal.write(`shell: ${(err as Error).message}\r\n`); }
    prompt();
  };

  let lineBuf = '';
  const onData = terminal.onData((data: string) => {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') { terminal.write('\r\n'); const l = lineBuf; lineBuf = ''; void submitLine(l); }
      else if (ch === '\x7f') { if (lineBuf.length) { lineBuf = lineBuf.slice(0, -1); terminal.write('\b \b'); } }
      else { lineBuf += ch; terminal.write(ch); }
    }
  });

  ctx.setTitle('Terminal');
  ctx.onClose(() => { onData.dispose(); if (typeof window !== 'undefined') window.removeEventListener('resize', onResize); terminal.dispose(); });

  return { terminal, submitLine, dispose() { onData.dispose(); terminal.dispose(); } };
}

function makeKernelClient(kernel: Kernel): KernelClient {
  const enc = new TextEncoder();
  return {
    async spawn(params: SpawnParams): Promise<SpawnHandle> {
      const { pid, stdout } = await kernel.spawn(params.code, {
        args: params.args, env: params.env, cwd: params.cwd, capabilities: CHILD_CAPABILITIES,
        captureStdout: params.captureStdout, captureStderr: params.captureStderr,
        stdinData: params.stdinData !== undefined ? enc.encode(params.stdinData) : undefined,
      });
      return { pid, stdout };
    },
    async wait(pid: number) { const { code } = await kernel.wait(pid); return { pid, code }; },
    async runPipeline(stages: PipelineStageParams[]): Promise<PipelineRunResult> {
      const result = await kernel.runPipeline(stages.map((s, i) => ({
        code: s.code, args: s.args, env: s.env, cwd: s.cwd, capabilities: CHILD_CAPABILITIES,
        captureStdout: i === stages.length - 1 ? s.captureStdout : false, captureStderr: s.captureStderr,
        stdinData: i === 0 && s.stdinData !== undefined ? enc.encode(s.stdinData) : undefined,
      })));
      return { pids: result.pids, exitCodes: result.exitCodes, lastStdout: result.lastStdout, stderr: result.stderr };
    },
  };
}

function makeFsClient(fs: FileSystemProvider): FsClient & { flush(): Promise<void> } {
  const enc = new TextEncoder(); const dec = new TextDecoder();
  interface Open { path: string; data: string; write: boolean; append: boolean }
  const open = new Map<number, Open>(); let nextFd = 1000; const pending: Array<Promise<unknown>> = [];
  const readFile = async (path: string): Promise<string> => {
    const h = (await fs.open(path, { read: true })) as FileHandle; const chunks: Uint8Array[] = []; let off = 0;
    for (;;) { const c = await fs.read(h, off, 65536); if (!c || c.byteLength === 0) break; chunks.push(new Uint8Array(c)); off += c.byteLength; }
    await fs.close(h); let t = 0; for (const c of chunks) t += c.byteLength; const buf = new Uint8Array(t); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; } return dec.decode(buf);
  };
  return {
    async flush() { await Promise.all(pending); },
    fsOpen(path, flags): number { const fd = nextFd++; open.set(fd, { path, data: '', write: !!flags.write, append: !!flags.append }); return fd; },
    fsWrite(fd, data): void { const o = open.get(fd); if (o) o.data += data; },
    async fsRead(fd): Promise<string> { const o = open.get(fd); if (!o) return ''; return readFile(o.path); },
    fsClose(fd): void { const o = open.get(fd); open.delete(fd); if (o && (o.write || o.append)) { pending.push((async () => { const h = (await fs.open(o.path, { write: !o.append, append: o.append, create: true, truncate: !o.append })) as FileHandle; await fs.write(h, enc.encode(o.data), 0); await fs.close(h); })()); } },
    async fsReaddir(path): Promise<string[]> { const e = await fs.readdir(path); return e.map((x) => x.name); },
    async fsStat(path): Promise<{ dir: boolean } | undefined> { try { const s = await fs.stat(path); return { dir: s.type === 'directory' }; } catch { return undefined; } },
  };
}

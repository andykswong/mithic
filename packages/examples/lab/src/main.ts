/**
 * `@mithic/example-lab` — the in-browser file-automation Lab composition root
 * (RFC 0001, Phase-1.1).
 *
 * {@link createLab} assembles the substrate the Lab loop stands on:
 *   - a VFS router: `MemoryFsProvider` on `/` (the working tree — `/in`, `/out`,
 *     `/work`, `/usr/bin`), `OPFSProvider` on `/persist` (saved workflows +
 *     installed-utility xattr caps survive reload — Task V6), `DeviceFsProvider`
 *     on `/dev`;
 *   - a {@link Kernel} over a {@link WorkerRuntime}, wired with the in-process
 *     command suite (coreutils + jq + curl) AND the exec-from-VFS path (the
 *     kernel reads `/usr/bin/<name>` bytes, checks the execute bit, parses the
 *     shebang, and reads the file's `security.capability` xattr — all from the
 *     same `vfs` it holds, no extra injection needed — Phase S);
 *   - the `@mithic/shell` interpreter, exposed headlessly as `run(line)` so the
 *     loop (and tests) can drive workflows without an xterm/DOM front-end.
 *
 * Phase V1 ships the composition root only: `/usr/bin` is empty; installs
 * (V2), ingest/download (V3), preview (V5), and persistence wiring (V6) layer on
 * top of the `kernel` + `vfs` this exposes.
 */
import { Kernel } from '@mithic/kernel';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider, DeviceFsProvider } from '@mithic/io/vfs';
import { OPFSProvider } from '@mithic/io/vfs/providers/opfs';
import type { OPFSStorageManager } from '@mithic/io/vfs/providers/opfs';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import type { Capability } from '@mithic/protocol';
import { Executor, parse } from '@mithic/shell';
import type {
  KernelClient,
  FsClient,
  SpawnParams,
  SpawnHandle,
  PipelineStageParams,
  PipelineRunResult,
} from '@mithic/shell';
import { createCommandSuite } from './commands.ts';

/** The mount points the Lab working tree lives on. */
const WORK_DIRS = ['/in', '/out', '/work', '/usr', '/usr/bin'];

/**
 * Capabilities the shell grants the commands it forks: read+write the working
 * tree and the device tree. Utilities installed into `/usr/bin` carry their OWN
 * narrower grant in their `security.capability` xattr; this is the parent grant
 * the kernel narrows them against (so an undeclared `net` is denied — V2).
 */
const CHILD_CAPABILITIES: Capability[] = [
  { type: 'fs', paths: ['/'], operations: ['read', 'write', 'execute'] },
  { type: 'fs', paths: ['/dev'], operations: ['read', 'write'] },
  { type: 'process', maxChildren: 16 },
];

export interface LabOptions {
  /**
   * Injectable OPFS storage for the `/persist` mount. Tests pass a unique
   * subdirectory so runs don't collide; passing the SAME storage to a fresh
   * {@link createLab} simulates a reload (Task V6). Defaults to a per-instance
   * subdirectory of `navigator.storage`. Set to `null` to skip the OPFS mount
   * (e.g. environments without OPFS).
   */
  persistStorage?: OPFSStorageManager | null;
}

export interface Lab {
  kernel: Kernel;
  /** The VFS router the loop ingests into, installs utilities into, and reads results from. */
  vfs: FileSystemRouter;
  /** Run one shell command line; resolves to its captured stdout. */
  run(line: string): Promise<string>;
  dispose(): void;
}

/** A {@link KernelClient} over the real {@link Kernel} (mirrors example-shell). */
function makeKernelClient(kernel: Kernel): KernelClient {
  const exitCodes = new Map<number, number>();
  return {
    async spawn(params: SpawnParams): Promise<SpawnHandle> {
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

/** An {@link FsClient} backed directly by a host VFS provider (mirrors example-shell). */
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

/** A fresh OPFS storage rooted under a unique subdirectory (per-instance isolation). */
function defaultPersistStorage(): OPFSStorageManager {
  let sub: Promise<FileSystemDirectoryHandle> | undefined;
  return {
    getDirectory: () => {
      sub ??= (async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(`lab-${Date.now()}-${Math.random().toString(36).slice(2)}`, { create: true });
      })();
      return sub;
    },
  };
}

/**
 * Boot the Lab substrate (no DOM): kernel + VFS + shell. Layered phases build the
 * drop→workflow→preview→download→save→re-run loop on the returned `kernel`/`vfs`.
 */
export async function createLab(options: LabOptions = {}): Promise<Lab> {
  const suite = createCommandSuite();

  const vfs = new FileSystemRouter();
  const memfs = new MemoryFsProvider();
  await vfs.mount('/', memfs);
  await vfs.mount('/dev', new DeviceFsProvider());

  if (options.persistStorage !== null) {
    const opfs = new OPFSProvider(options.persistStorage ?? defaultPersistStorage());
    await vfs.mount('/persist', opfs);
  }

  // The Lab working tree (`/in`, `/out`, `/work`, `/usr/bin`).
  for (const dir of WORK_DIRS) {
    try { await vfs.mkdir(dir); } catch { /* already exists */ }
  }

  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    resolveCommand: (name) => suite.resolve(name),
    launcher: suite.launcher,
  });

  const kernelClient = makeKernelClient(kernel);

  const run = async (line: string): Promise<string> => {
    const context = { cwd: '/', env: { HOME: '/', PWD: '/', PATH: '/usr/bin:/bin' } as Record<string, string> };
    let captured = '';
    const fsClient = makeFsClient(memfs);
    const executor = new Executor(kernelClient, context, {
      resolve: (name) => suite.resolve(name),
      fs: fsClient,
      onStdout: (s) => { captured += s; },
      onStderr: () => { /* discarded in the headless harness */ },
    });
    await executor.run(parse(line));
    await fsClient.flush();
    return captured;
  };

  return {
    kernel,
    vfs,
    run,
    dispose() { /* WorkerRuntime workers are GC'd with the kernel; no handles held here. */ },
  };
}

// Auto-boot when loaded as the page entry (index.html).
if (typeof document !== 'undefined' && document.getElementById('lab')) {
  void createLab();
}

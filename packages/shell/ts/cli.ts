/**
 * Main thread orchestrator for the shell-in-Worker architecture.
 *
 * Spawns a shell Worker that runs the WASM shell component. Handles CALL_SPAWN
 * requests from the shell Worker via sync-bridge, delegating process creation
 * to WorkerProcessManager which spawns each command in its own Process Worker.
 *
 * Architecture:
 *   Main Thread (this file) ─── sync-bridge ──→ Shell Worker (worker/shell.worker.ts)
 *        │                                           │
 *        │ WorkerProcessManager.spawn()              │ ProxyProcessManager (delegates here)
 *        ▼                                           │
 *   Process Workers (one per command)                │
 *        │                                           │
 *        └── SharedPipe SABs ◄───────────────────────┘
 */

import '@mithic/worker';
import { readFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleBlockingCalls, type CallHandler } from '@mithic/io/io';
import type { InputStreamHandler } from '@mithic/io/io';
import { MemoryFsProvider, DeviceFsProvider, FileSystemRouter } from '@mithic/io/vfs';
import { NodeFsProvider } from '@mithic/io/vfs/providers/node-fs';
import { NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import { pipeHandleMap, type SpawnExternalOptions } from '@mithic/process/manager/worker';
import { ComponentProcessWorker } from '@mithic/process/manager/component-worker';
import { InlineProcessWorker } from '@mithic/process/manager/inline-worker';
import { CALL_SPAWN } from '@mithic/process/manager/proxy';
import type { CompileResult } from '@mithic/process/component/compiler';
import { createComponentCompiler } from '@mithic/process/component/compiler';
import { CommandRegistry } from '@mithic/process/component/registry';
import type { ProcessWorker } from '@mithic/process/types';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { modules as shellModules } from '@mithic/shell/component';
import { modules as coreutilsModules } from '@mithic/coreutils/component';
import { inputFromSharedBuffer, outputFromSharedBuffer } from '@mithic/process/io';
import { runChmod } from './commands/chmod.ts';
import { Runtime } from './runtime.ts';
import type { ShellWorkerInit } from './worker/shell.ts';

// --- Fetch raw module bytes (needed for CompileResult sent to process Workers) ---

async function fetchModuleBytes(dataUris: Record<string, string>): Promise<Record<string, Uint8Array>> {
  const modules: Record<string, Uint8Array> = {};
  await Promise.all(
    Object.entries(dataUris).map(async ([name, uri]) => {
      const response = await fetch(uri);
      modules[name] = new Uint8Array(await response.arrayBuffer());
    }),
  );
  return modules;
}

const [shellRawModules, coreutilsRawModules] = await Promise.all([
  fetchModuleBytes(shellModules),
  fetchModuleBytes(coreutilsModules),
]);

// --- Read jco JS sources (needed for CompileResult sent to process Workers) ---

const shellComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/shell/component')));
const coreutilsComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/coreutils/component')));
const shellJsSource = readFileSync(join(shellComponentDir, 'component.js'), 'utf-8');
const coreutilsJsSource = readFileSync(join(coreutilsComponentDir, 'component.js'), 'utf-8');

// --- Build CompileResults for process Workers ---

const shellCompileResult: CompileResult = {
  modules: shellRawModules,
  jsFiles: { 'component.js': shellJsSource },
  cached: true,
};
const coreutilsCompileResult: CompileResult = {
  modules: coreutilsRawModules,
  jsFiles: { 'component.js': coreutilsJsSource },
  cached: true,
};

// --- Setup compiler for dynamic WASM ---

const { port1: compilerPort1, port2: compilerPort2 } = new MessageChannel();
const compilerWorker = new Worker(
  new URL(import.meta.resolve('@mithic/process/worker/compiler')),
  { type: 'module', name: 'mithic-compiler' },
);
compilerWorker.postMessage({ type: '__port', port: compilerPort2 }, [compilerPort2]);
const compilerBridge = createComponentCompiler(compilerPort1 as unknown as MessagePort);
const registry = new CommandRegistry({ compiler: compilerBridge });

// --- Shared VFS (created before Runtime so createWorker closure can reference it) ---

const hostStderr = new NodeStderrHandler();
const memFs = new MemoryFsProvider();
memFs.mkdir('/tmp');
memFs.mkdir('/root');
const hostFs = new NodeFsProvider({ root: process.cwd() });

// --- Command resolver ---

const processWorkerUrl = new URL(import.meta.resolve('@mithic/process/worker/process'));

function resolveFromPath(file: string, env: Record<string, string>): string | undefined {
  if (file.includes('/')) {
    try { memFs.stat(file); return file; } catch { return undefined; }
  }
  const pathDirs = (env['PATH'] ?? '/usr/bin:/bin').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = `${dir}/${file}`;
    try {
      const stat = memFs.stat(candidate);
      if (stat.mode & 0o111) return candidate;
    } catch { /* not found */ }
  }
  return undefined;
}

function createScriptWorker(path: string, name?: string): ProcessWorker | undefined {
  try {
    const stat = memFs.stat(path);
    if (!(stat.mode & 0o111)) return undefined;
    const handle = memFs.open(path, { read: true });
    let bytes: Uint8Array;
    try { bytes = memFs.read(handle, 0, Number(stat.size)); }
    finally { memFs.close(handle); }

    if (CommandRegistry.isWasmComponent(bytes)) {
      const result = registry.resolveBytes(bytes, path);
      if (!result) return undefined;
      const worker = new Worker(processWorkerUrl, { type: 'module', name });
      return new ComponentProcessWorker(worker, result);
    }

    const text = new TextDecoder().decode(bytes);
    let interpreter = 'sh';
    let interpArgs: string[] = [];
    if (text.startsWith('#!')) {
      const firstLine = text.split('\n')[0].slice(2).trim();
      const parts = firstLine.split(/\s+/);
      interpreter = parts[0];
      interpArgs = parts.slice(1);
    }
    const interpName = interpreter.includes('/') ? interpreter.split('/').pop()! : interpreter;
    if (interpName === 'sh' || interpName === 'bash') {
      const worker = new Worker(processWorkerUrl, { type: 'module', name });
      const pw = new ComponentProcessWorker(worker, shellCompileResult);
      return {
        run(options, transfer) {
          const scriptArgs = options.args.slice(1);
          pw.run({ ...options, args: [interpName, ...interpArgs, path, ...scriptArgs] }, transfer);
        },
        terminate: () => pw.terminate(),
        addEventListener: (type, handler) => pw.addEventListener(type, handler),
      };
    }
    const errorMsg = `${path}: ${interpreter}: interpreter not found\n`;
    return new InlineProcessWorker((opts) => {
      if (opts.inheritStderr) {
        hostStderr.write(new TextEncoder().encode(errorMsg));
      } else {
        const stderr = outputFromSharedBuffer(opts.stderrBuf, opts.stderrBufSize);
        stderr.write(new TextEncoder().encode(errorMsg));
        stderr[Symbol.dispose]();
      }
      return 127;
    });
  } catch { return undefined; }
}

function createWorker(file: string, name?: string): ProcessWorker | undefined {
  const cmdName = file.includes('/') ? file.split('/').pop()! : file;
  if (cmdName === 'chmod') {
    return new InlineProcessWorker((opts) => {
      const chmodArgs = opts.args.slice(1);
      const writeErr = (msg: string) => {
        if (opts.inheritStderr) {
          hostStderr.write(new TextEncoder().encode(msg));
        } else {
          const stderr = outputFromSharedBuffer(opts.stderrBuf, opts.stderrBufSize);
          stderr.write(new TextEncoder().encode(msg));
          stderr[Symbol.dispose]();
        }
      };
      return runChmod(chmodArgs, memFs, writeErr);
    });
  }
  if (cmdName === 'sh' || cmdName === 'bash') {
    const worker = new Worker(processWorkerUrl, { type: 'module', name });
    return new ComponentProcessWorker(worker, shellCompileResult);
  }
  if (COREUTILS_COMMANDS.has(cmdName)) {
    const worker = new Worker(processWorkerUrl, { type: 'module', name });
    return new ComponentProcessWorker(worker, coreutilsCompileResult);
  }
  if (file.includes('/')) {
    return createScriptWorker(file, name);
  }
  const resolved = resolveFromPath(file, {});
  if (resolved) return createScriptWorker(resolved, name);
  return undefined;
}

// --- Async stdin handler for the main thread ---

function createAsyncStdinHandler(): InputStreamHandler {
  let buffer: Uint8Array = new Uint8Array(0);
  let waiting: ((chunk: Uint8Array) => void) | null = null;
  let ended = false;

  process.stdin.on('data', (chunk: Buffer) => {
    const data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (waiting) {
      const cb = waiting;
      waiting = null;
      cb(data);
    } else {
      const merged = new Uint8Array(buffer.length + data.length);
      merged.set(buffer);
      merged.set(data, buffer.length);
      buffer = merged;
    }
  });
  process.stdin.on('end', () => {
    ended = true;
    if (waiting) {
      const cb = waiting;
      waiting = null;
      cb(new Uint8Array(0));
    }
  });
  if (process.stdin.isPaused()) process.stdin.resume();

  return {
    read(len: number): Uint8Array | undefined {
      if (buffer.length > 0) {
        const chunk = buffer.subarray(0, len);
        buffer = buffer.subarray(len);
        return new Uint8Array(chunk);
      }
      if (ended) throw { tag: 'closed' };
      return undefined;
    },
    blockingRead(len: number): Promise<Uint8Array> {
      if (buffer.length > 0) {
        const chunk = buffer.subarray(0, len);
        buffer = buffer.subarray(len);
        return Promise.resolve(new Uint8Array(chunk));
      }
      if (ended) return Promise.reject({ tag: 'closed' });
      return new Promise((resolve, reject) => {
        waiting = (chunk) => {
          if (chunk.length === 0) { reject({ tag: 'closed' }); return; }
          buffer = chunk;
          const result = buffer.subarray(0, len);
          buffer = buffer.subarray(len);
          resolve(new Uint8Array(result));
        };
      });
    },
  };
}

// --- Create Runtime ---

const vfs = new FileSystemRouter();
await vfs.mount('/', memFs);
await vfs.mount('/root', hostFs);
await vfs.mount('/dev', new DeviceFsProvider({
  stdout: new NodeStdoutHandler(),
  stderr: new NodeStderrHandler(),
}));

const runtime = new Runtime({
  fs: vfs,
  stdio: {
    stdin: createAsyncStdinHandler(),
    stdout: new NodeStdoutHandler(),
    stderr: new NodeStderrHandler(),
  },
  isatty: { stdin: isatty(0), stdout: isatty(1), stderr: isatty(2) },
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)),
    PATH: '/usr/bin:/bin',
    HOME: '/root',
  },
  cwd: '/root',
  createWorker,
  maxWorkers: 8,
});

// --- Spawn shell Worker via Runtime's IoLoop and WPM spawn handler ---

const spawnHandler: CallHandler = async (call, _id, payload) => {
  if (call === CALL_SPAWN) {
    const p = payload as {
      file: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
      exitSlotBuf?: SharedArrayBuffer;
      signalSlotBuf?: SharedArrayBuffer;
      stdinBuf?: SharedArrayBuffer;
      stdinBufSize?: number;
      stdoutBuf?: SharedArrayBuffer;
      stdoutBufSize?: number;
      stderrBuf?: SharedArrayBuffer;
      stderrBufSize?: number;
    };

    const options: SpawnExternalOptions = {
      env: p.env,
      cwd: p.cwd,
      exitSlotBuf: p.exitSlotBuf,
      signalSlotBuf: p.signalSlotBuf,
    };

    if (p.stdinBuf && p.stdinBufSize) {
      const input = inputFromSharedBuffer(p.stdinBuf, p.stdinBufSize);
      pipeHandleMap.set(input, { buffer: p.stdinBuf, bufferSize: p.stdinBufSize });
      options.stdin = input;
    }
    if (p.stdoutBuf && p.stdoutBufSize) {
      const output = outputFromSharedBuffer(p.stdoutBuf, p.stdoutBufSize);
      pipeHandleMap.set(output, { buffer: p.stdoutBuf, bufferSize: p.stdoutBufSize });
      options.stdout = output;
    }
    if (p.stderrBuf && p.stderrBufSize) {
      const stderr = outputFromSharedBuffer(p.stderrBuf, p.stderrBufSize);
      pipeHandleMap.set(stderr, { buffer: p.stderrBuf, bufferSize: p.stderrBufSize });
      options.stderr = stderr;
    }

    const proc = runtime.workerManager.spawn(p.file, p.args, options);
    return { pid: proc.pid() };
  }
  throw new Error(`Unknown call: ${call}`);
};

const { port1: shellPort1, port2: shellPort2 } = new MessageChannel();
handleBlockingCalls(spawnHandler, shellPort1);

const shellIoPort = runtime.ioLoop.addWorker();

const shellWorker = new Worker(
  new URL('./worker/shell.worker.ts', import.meta.url),
  { type: 'module', name: 'mithic-shell' },
);

const initMsg: ShellWorkerInit = {
  type: '__shell_init',
  port: shellPort2 as unknown as MessagePort,
  ioPort: shellIoPort,
  shellArgs: ['bash', ...process.argv.slice(2)],
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)),
    PATH: '/usr/bin:/bin',
  },
  isattyStdin: isatty(0),
  isattyStdout: isatty(1),
  isattyStderr: isatty(2),
};

shellWorker.postMessage(initMsg, [shellPort2 as unknown as Transferable, shellIoPort as unknown as Transferable]);

// --- Wait for shell Worker to exit ---

let shellExitCode = 0;
shellWorker.onmessage = (e: MessageEvent) => {
  if (e.data?.type === '__exit') {
    shellExitCode = e.data.code ?? 0;
  }
};

shellWorker.addEventListener('close', () => {
  runtime[Symbol.dispose]();
  registry[Symbol.dispose]();
  compilerWorker.terminate();
  process.exit(shellExitCode);
});

shellWorker.addEventListener('error', () => {
  runtime[Symbol.dispose]();
  registry[Symbol.dispose]();
  compilerWorker.terminate();
  process.exit(1);
});

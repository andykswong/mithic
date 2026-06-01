/**
 * Main thread orchestrator for the shell-in-Worker architecture.
 *
 * Spawns a shell Worker that runs the WASM shell component. Handles CALL_SPAWN
 * requests from the shell Worker via sync-bridge, delegating process creation
 * to WorkerProcessManager which spawns each command in its own Process Worker.
 *
 * Architecture:
 *   Main Thread (this file) ─── sync-bridge ──→ Shell Worker (shell-worker.node.ts)
 *        │                                           │
 *        │ WorkerProcessManager.spawn()              │ ProxyProcessManager (delegates here)
 *        ▼                                           │
 *   Process Workers (one per command)                │
 *        │                                           │
 *        └── SharedPipe SABs ◄───────────────────────┘
 */

import { readFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleBlockingCalls, IoLoop, createCallHandler, type CallHandler } from '@mithic/io/io';
import { MemoryFsProvider, DeviceFsProvider, SyncFileSystemRouter } from '@mithic/io/vfs';
import { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import { WorkerProcessManager, pipeHandleMap, type SpawnExternalOptions } from '@mithic/process/manager/worker';
import { CALL_SPAWN } from '@mithic/process/manager/proxy';
import type { CompileResult } from '@mithic/process/component/compiler';
import { NodeWorkerFactory } from '@mithic/io/io/worker-factory.node';
import { createComponentCompiler } from '@mithic/process/component/compiler';
import { CommandRegistry } from '@mithic/process/component/registry';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { modules as shellModules } from '@mithic/shell/component';
import { modules as coreutilsModules } from '@mithic/coreutils/component';
import { inputFromSharedBuffer, outputFromSharedBuffer } from '@mithic/process/io';
import type { ShellWorkerInit } from './shell-worker.node.ts';

// --- Fetch raw module bytes ---

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

// --- Read jco JS sources ---

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

const workerFactory = new NodeWorkerFactory();
const { port1: compilerPort1, port2: compilerPort2 } = new MessageChannel();
const compilerWorker = workerFactory.create(
  new URL(import.meta.resolve('@mithic/process/worker/compiler.node')),
  { name: 'mithic-compiler' },
);
compilerWorker.postMessage({ type: '__port', port: compilerPort2 }, [compilerPort2 as unknown as Transferable]);
const compilerBridge = createComponentCompiler(compilerPort1 as unknown as MessagePort);
const registry = new CommandRegistry({ compiler: compilerBridge });

// --- Command resolver ---

// Commands handled locally in the shell Worker (not via process Workers)
const LOCAL_COMMANDS = new Set(['chmod']);

function resolveCommand(file: string): CompileResult | undefined {
  const name = file.includes('/') ? file.split('/').pop()! : file;
  if (LOCAL_COMMANDS.has(name)) return undefined;
  if (name === 'sh' || name === 'bash') return shellCompileResult;
  if (COREUTILS_COMMANDS.has(name)) return coreutilsCompileResult;
  return undefined;
}

// --- Shared VFS served via IoLoop ---

const memFs = new MemoryFsProvider();
memFs.mkdir('/tmp');
const vfs = new SyncFileSystemRouter();
vfs.mount('/', memFs);
vfs.mount('/dev', new DeviceFsProvider({
  stdin: new NodeStdinHandler(),
  stdout: new NodeStdoutHandler(),
  stderr: new NodeStderrHandler(),
}));

const ioLoop = new IoLoop({ onCall: createCallHandler({ fs: vfs }) });

// --- WorkerProcessManager ---

let spawnHandler: CallHandler;

const workerManager = new WorkerProcessManager({
  resolveCommand,
  workerFactory,
  processWorkerUrl: new URL(import.meta.resolve('@mithic/process/worker/process.node')),
  maxWorkers: 8,
  createIoPort: () => ioLoop.addWorker(),
  createSpawnPort: () => {
    const { port1, port2 } = new MessageChannel();
    handleBlockingCalls(spawnHandler, port1);
    return port2;
  },
});

// --- Spawn handler: responds to CALL_SPAWN from shell Worker ---

spawnHandler = async (call, _id, payload) => {
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

    // Reconstruct pipe streams from SABs if provided by the shell Worker
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

    const proc = workerManager.spawn(p.file, p.args, options);
    return { pid: proc.pid() };
  }
  throw new Error(`Unknown call: ${call}`);
};

// --- Create shell Worker ---

const { port1: shellPort1, port2: shellPort2 } = new MessageChannel();
handleBlockingCalls(spawnHandler, shellPort1);

const shellIoPort = ioLoop.addWorker();

const shellWorker = workerFactory.create(
  new URL('./shell-worker.node.ts', import.meta.url),
  { name: 'mithic-shell' },
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
  shellModuleBytes: shellRawModules,
  shellJsSource,
  coreutilsModuleBytes: coreutilsRawModules,
  coreutilsJsSource,
  isattyStdin: isatty(0),
  isattyStdout: isatty(1),
  isattyStderr: isatty(2),
};

shellWorker.postMessage(initMsg, [shellPort2 as unknown as Transferable, shellIoPort as unknown as Transferable]);

// --- Wait for shell Worker to exit ---

shellWorker.on('exit', (code: number) => {
  ioLoop.dispose();
  workerManager[Symbol.dispose]();
  registry[Symbol.dispose]();
  compilerWorker.terminate();
  process.exit(code);
});

shellWorker.on('error', (err: Error) => {
  console.error('Shell worker error:', err);
  ioLoop.dispose();
  workerManager[Symbol.dispose]();
  registry[Symbol.dispose]();
  compilerWorker.terminate();
  process.exit(1);
});

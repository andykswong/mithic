/**
 * Shell Worker entry point for Node.js worker_threads.
 *
 * Receives configuration from the main thread orchestrator, sets up WASI + ProxyProcessManager,
 * and runs the shell WASM component. Spawn/pipe calls are delegated back to the main thread
 * via the sync-bridge BlockingCallFn.
 */

import { parentPort } from 'node:worker_threads';
import { createBlockingCall, WorkerIo } from '@mithic/io/io';
import { SyncBridgeFsProvider, createStdinHandler, createStdoutHandler, createStderrHandler } from '@mithic/io/io/providers/sync-bridge';
import { ProxyProcessManager } from '@mithic/process/manager/proxy';
import { SimpleProcessManager } from '@mithic/process/manager/simple';
import { WASIShim } from '@mithic/wasip2';
import { WASIProcess } from '@mithic/process/instantiation';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { DeviceFsProvider, SyncFileSystemRouter } from '@mithic/io/vfs';
import type { ProcessManager, SpawnOptions, Signal, PipeOptions } from '@mithic/process/types';
import { createCommandResolver, type SyncInstantiateFn } from './commands.ts';

export interface ShellWorkerInit {
  type: '__shell_init';
  port: MessagePort;
  ioPort: MessagePort;
  shellArgs: string[];
  env: Record<string, string>;
  shellModuleBytes: Record<string, Uint8Array>;
  shellJsSource: string;
  coreutilsModuleBytes: Record<string, Uint8Array>;
  coreutilsJsSource: string;
  isattyStdin: boolean;
  isattyStdout: boolean;
  isattyStderr: boolean;
}

function syncInstantiateCore(module: WebAssembly.Module, imports: WebAssembly.Imports): WebAssembly.Instance {
  return new WebAssembly.Instance(module, imports);
}

parentPort?.on('message', (msg: ShellWorkerInit) => {
  if (msg?.type !== '__shell_init') return;

  const { port, ioPort, shellArgs, env, shellModuleBytes, shellJsSource, coreutilsModuleBytes, coreutilsJsSource, isattyStdin, isattyStdout, isattyStderr } = msg;

  const blockingCall = createBlockingCall(port);

  // Setup VFS via sync-bridge (backed by main thread's IoLoop)
  const workerIo = new WorkerIo(ioPort);
  const syncFs = new SyncBridgeFsProvider(workerIo);
  const vfs = new SyncFileSystemRouter();
  vfs.mount('/', syncFs);
  vfs.mount('/dev', new DeviceFsProvider({
    stdin: createStdinHandler(workerIo),
    stdout: createStdoutHandler(workerIo),
    stderr: createStderrHandler(workerIo),
  }));
  const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(vfs, '/'));

  // Host stdio routed through sync-bridge to the main thread
  const hostStdin = new InputStream(createStdinHandler(workerIo), undefined, isattyStdin);
  const hostStdout = new OutputStream(createStdoutHandler(workerIo), undefined, isattyStdout);
  const hostStderr = new OutputStream(createStderrHandler(workerIo), undefined, isattyStderr);

  const proxyManager = new ProxyProcessManager(blockingCall);

  // Compile shell WASM modules synchronously
  const shellCompiled = new Map<string, WebAssembly.Module>();
  for (const [name, bytes] of Object.entries(shellModuleBytes)) {
    shellCompiled.set(name, new WebAssembly.Module(bytes.slice().buffer));
  }

  const shellCompileCore = (path: string): WebAssembly.Module => {
    const mod = shellCompiled.get(path);
    if (!mod) throw new Error(`Shell module not found: ${path}`);
    return mod;
  };

  // Eval shell jco JS source to get the synchronous instantiate function
  const shellStripped = shellJsSource
    .replace(/^export\s+/gm, '')
    .replace(/^import\s+.*$/gm, '')
    .replace(/import\.meta/g, '__importMeta');
  const shellInstantiate = new Function('__importMeta', `${shellStripped}\nreturn instantiate;`)({ url: 'file:///shell-worker' }) as SyncInstantiateFn;

  // Compile coreutils WASM modules synchronously
  const coreutilsCompiled = new Map<string, WebAssembly.Module>();
  for (const [name, bytes] of Object.entries(coreutilsModuleBytes)) {
    coreutilsCompiled.set(name, new WebAssembly.Module(bytes.slice().buffer));
  }

  const coreutilsCompileCore = (path: string): WebAssembly.Module => {
    const mod = coreutilsCompiled.get(path);
    if (!mod) throw new Error(`Coreutils module not found: ${path}`);
    return mod;
  };

  // Eval coreutils jco JS source to get the synchronous instantiate function
  const coreutilsStripped = coreutilsJsSource
    .replace(/^export\s+/gm, '')
    .replace(/^import\s+.*$/gm, '')
    .replace(/import\.meta/g, '__importMeta');
  const coreutilsInstantiate = new Function('__importMeta', `${coreutilsStripped}\nreturn instantiate;`)({ url: 'file:///coreutils-worker' }) as SyncInstantiateFn;

  // Composite ProcessManager: try proxy (Workers) first, fall back to local on "not-found"
  let localManager: SimpleProcessManager;
  const processManager: ProcessManager = {
    spawn(file: string, args: string[], options?: SpawnOptions) {
      try {
        return proxyManager.spawn(file, args, options);
      } catch (e: unknown) {
        const isNotFound = (e && typeof e === 'object' && 'payload' in e &&
          (e as { payload: { tag: string } }).payload?.tag === 'not-found');
        if (isNotFound) {
          return localManager.spawn(file, args, options);
        }
        throw e;
      }
    },
    createPipe(options?: PipeOptions) { return proxyManager.createPipe(options); },
    dupOutputStream(stream) { return proxyManager.dupOutputStream(stream); },
    signal(sig: Signal) { proxyManager.signal(sig); },
    get hasForeground() { return proxyManager.hasForeground; },
  };

  const shim = new WASIShim({
    sandbox: {
      preopens: { '/': rootDescriptor },
      env,
      args: shellArgs,
      cwd: '/',
      stdin: hostStdin.dup(),
      stdout: hostStdout.dup(),
      stderr: hostStderr.dup(),
    },
  });

  const wasiProcess = new WASIProcess({ manager: processManager });
  const imports = { ...shim.getImportObject(), ...wasiProcess.getImportObject() };

  // Local command resolver handles chmod, scripts, PATH lookup, sh/bash, coreutils
  // This is the fallback when the remote WPM returns "not-found"
  const localResolver = createCommandResolver({
    memFs: syncFs,
    rootDescriptor,
    shellInstantiate,
    shellCompileCore,
    coreutilsInstantiate,
    coreutilsCompileCore,
    createProcessImports: () => wasiProcess.getImportObject(),
  });
  localManager = new SimpleProcessManager({
    commandResolver: localResolver,
    hostStreams: { stdin: hostStdin.dup(), stdout: hostStdout.dup(), stderr: hostStderr.dup() },
  });

  try {
    const { run } = shellInstantiate(shellCompileCore, imports, syncInstantiateCore);
    const code = run.run() ?? 0;
    shim[Symbol.dispose]();
    process.exit(code);
  } catch (e: unknown) {
    shim[Symbol.dispose]();
    if (e instanceof ComponentExit) {
      process.exit(e.code);
    }
    throw e;
  }
});

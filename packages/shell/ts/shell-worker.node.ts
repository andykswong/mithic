/**
 * Shell Worker entry point for Node.js worker_threads.
 *
 * Receives configuration from the main thread orchestrator, sets up WASI + ProxyProcessManager,
 * and runs the shell WASM component. Spawn/pipe calls are delegated back to the main thread
 * via the sync-bridge BlockingCallFn.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createBlockingCall, WorkerIo } from '@mithic/io/io';
import { SyncBridgeFsProvider } from '@mithic/io/io/providers/sync-bridge';
import { ProxyProcessManager } from '@mithic/process/manager/proxy';
import { WASIShim } from '@mithic/wasip2';
import { WASIProcess } from '@mithic/process/instantiation';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { DeviceFsProvider, SyncFileSystemRouter } from '@mithic/io/vfs';
import type { SyncShellComponent } from './shell.ts';

export interface ShellWorkerInit {
  type: '__shell_init';
  port: MessagePort;
  ioPort: MessagePort;
  shellArgs: string[];
  env: Record<string, string>;
  shellModuleBytes: Record<string, Uint8Array>;
  shellJsSource: string;
  isattyStdin: boolean;
  isattyStdout: boolean;
  isattyStderr: boolean;
}

function syncInstantiateCore(module: WebAssembly.Module, imports: WebAssembly.Imports): WebAssembly.Instance {
  return new WebAssembly.Instance(module, imports);
}

parentPort?.on('message', (msg: ShellWorkerInit) => {
  if (msg?.type !== '__shell_init') return;

  const { port, ioPort, shellArgs, env, shellModuleBytes, shellJsSource, isattyStdin, isattyStdout, isattyStderr } = msg;

  const blockingCall = createBlockingCall(port);
  const processManager = new ProxyProcessManager(blockingCall);

  // Setup VFS via sync-bridge (backed by main thread's IoLoop)
  const workerIo = new WorkerIo(ioPort);
  const syncFs = new SyncBridgeFsProvider(workerIo);
  const vfs = new SyncFileSystemRouter();
  vfs.mount('/', syncFs);
  vfs.mount('/dev', new DeviceFsProvider({
    stdin: new NodeStdinHandler(),
    stdout: new NodeStdoutHandler(),
    stderr: new NodeStderrHandler(),
  }));
  const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(vfs, '/'));

  // Host stdio (Worker inherits parent's stdio via worker_threads)
  const hostStdin = new InputStream(new NodeStdinHandler(), undefined, isattyStdin);
  const hostStdout = new OutputStream(new NodeStdoutHandler(), undefined, isattyStdout);
  const hostStderr = new OutputStream(new NodeStderrHandler(), undefined, isattyStderr);

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

  // Compile WASM modules synchronously
  const compiled = new Map<string, WebAssembly.Module>();
  for (const [name, bytes] of Object.entries(shellModuleBytes)) {
    compiled.set(name, new WebAssembly.Module(bytes.slice().buffer));
  }

  const compileCore = (path: string): WebAssembly.Module => {
    const mod = compiled.get(path);
    if (!mod) throw new Error(`Shell module not found: ${path}`);
    return mod;
  };

  // Eval jco JS source to get the synchronous instantiate function
  const stripped = shellJsSource
    .replace(/^export\s+/gm, '')
    .replace(/^import\s+.*$/gm, '')
    .replace(/import\.meta/g, '__importMeta');
  const instantiate = new Function('__importMeta', `${stripped}\nreturn instantiate;`)({ url: 'file:///shell-worker' }) as SyncShellComponent['instantiate'];

  try {
    const { run } = instantiate(compileCore, imports, syncInstantiateCore);
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

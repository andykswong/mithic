import { createBlockingCall, WorkerIo } from '@mithic/io/io';
import { SyncBridgeFsProvider, createStdinHandler, createStdoutHandler, createStderrHandler } from '@mithic/io/io/providers/sync-bridge';
import { ProxyProcessManager } from '@mithic/process/manager/proxy';
import { WASIShim } from '@mithic/wasip2';
import { WASIProcess } from '@mithic/process/instantiation';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { DeviceFsProvider, SyncFileSystemRouter } from '@mithic/io/vfs';
import { instantiate as shellAsyncInstantiate, modules as shellModules } from '@mithic/shell/component';
import type { SyncInstantiateFn } from '@mithic/process/component/registry';

export interface ShellWorkerInit {
  type: '__shell_init';
  port: MessagePort;
  ioPort: MessagePort;
  shellArgs: string[];
  env: Record<string, string>;
  cwd: string;
  isattyStdin: boolean;
  isattyStdout: boolean;
  isattyStderr: boolean;
}

function syncInstantiateCore(module: WebAssembly.Module, imports: WebAssembly.Imports): WebAssembly.Instance {
  return new WebAssembly.Instance(module, imports);
}

export async function handleShellInit(msg: ShellWorkerInit): Promise<number> {
  const { port, ioPort, shellArgs, env, isattyStdin, isattyStdout, isattyStderr } = msg;

  const blockingCall = createBlockingCall(port);

  // VFS via sync-bridge
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

  // Host stdio
  const hostStdin = new InputStream(createStdinHandler(workerIo), undefined, isattyStdin);
  const hostStdout = new OutputStream(createStdoutHandler(workerIo), undefined, isattyStdout);
  const hostStderr = new OutputStream(createStderrHandler(workerIo), undefined, isattyStderr);

  // All commands route through WPM on the main thread
  const proxyManager = new ProxyProcessManager(blockingCall);

  // Compile shell WASM modules
  const shellCompiled = new Map<string, WebAssembly.Module>();
  await Promise.all(
    Object.entries(shellModules).map(async ([name, uri]) => {
      const bytes = await (await fetch(uri)).arrayBuffer();
      shellCompiled.set(name, await WebAssembly.compile(bytes));
    }),
  );

  const shellCompileCore = (path: string): WebAssembly.Module => {
    const mod = shellCompiled.get(path);
    if (!mod) throw new Error(`Shell module not found: ${path}`);
    return mod;
  };

  const shellInstantiate = shellAsyncInstantiate as unknown as SyncInstantiateFn;

  const shim = new WASIShim({
    sandbox: {
      preopens: { '/': rootDescriptor },
      env,
      args: shellArgs,
      cwd: msg.cwd ?? '/',
      stdin: hostStdin.dup(),
      stdout: hostStdout.dup(),
      stderr: hostStderr.dup(),
    },
  });

  const wasiProcess = new WASIProcess({ manager: proxyManager });
  const imports = { ...shim.getImportObject(), ...wasiProcess.getImportObject() };

  try {
    const { run } = shellInstantiate(shellCompileCore, imports, syncInstantiateCore);
    const code = run.run() ?? 0;
    shim[Symbol.dispose]();
    return code;
  } catch (e: unknown) {
    shim[Symbol.dispose]();
    if (e instanceof ComponentExit) return e.code;
    throw e;
  }
}

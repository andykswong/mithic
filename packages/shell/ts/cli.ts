import { isatty } from 'node:tty';
import { WASIShim } from '@mithic/wasip2';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { WASIProcess } from '@mithic/process/instantiation';
import { SimpleProcessManager } from '@mithic/process/impl/simple';
import { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { MemoryFsProvider, DeviceFsProvider, SyncFileSystemRouter } from '@mithic/io/vfs';
import { createCommandResolver, type SyncInstantiateFn } from './commands.ts';
import { instantiate as shellInstantiate, modules as shellModules } from '@mithic/shell/component';
import { instantiate as coreutilsInstantiate, modules as coreutilsModules } from '@mithic/coreutils/component';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { NodeWorkerFactory } from '@mithic/io/io/worker-factory.node';
import { createCompilerBridge } from '@mithic/process/impl/compiler-bridge';
import { ComponentRegistry } from '@mithic/process/impl/component-registry';

async function compileModules(dataUris: Record<string, string>): Promise<Map<string, WebAssembly.Module>> {
  const compiled = new Map<string, WebAssembly.Module>();
  await Promise.all(
    Object.entries(dataUris).map(async ([name, uri]) => {
      const response = await fetch(uri);
      const bytes = await response.arrayBuffer();
      compiled.set(name, await WebAssembly.compile(bytes));
    }),
  );
  return compiled;
}

const shellPrecompiled = await compileModules(shellModules);
const coreutilsPrecompiled = await compileModules(coreutilsModules);

function shellCompileCore(path: string): WebAssembly.Module {
  const mod = shellPrecompiled.get(path);
  if (!mod) throw new Error(`Shell module not found: ${path}`);
  return mod;
}

function coreutilsCompileCore(path: string): WebAssembly.Module {
  const mod = coreutilsPrecompiled.get(path);
  if (!mod) throw new Error(`Coreutils module not found: ${path}`);
  return mod;
}

const workerFactory = new NodeWorkerFactory();
const { port1: compilerPort1, port2: compilerPort2 } = new MessageChannel();
const compilerWorker = workerFactory.create(
  new URL(import.meta.resolve('@mithic/process/impl/compiler-worker.node')),
  { name: 'mithic-compiler' },
);
compilerWorker.postMessage({ type: '__port', port: compilerPort2 }, [compilerPort2 as unknown as Transferable]);
const compilerBridge = createCompilerBridge(compilerPort1 as unknown as MessagePort);
const registry = new ComponentRegistry({
  precompiled: new Map([
    ['shell', {
      commands: new Set(['sh', 'bash']),
      compileCore: shellCompileCore,
      instantiate: shellInstantiate as unknown as SyncInstantiateFn,
    }],
    ['coreutils', {
      commands: COREUTILS_COMMANDS,
      compileCore: coreutilsCompileCore,
      instantiate: coreutilsInstantiate as unknown as SyncInstantiateFn,
    }],
  ]),
  compiler: compilerBridge,
});

const memFs = new MemoryFsProvider();
memFs.mkdir('/tmp');
const vfs = new SyncFileSystemRouter();
vfs.mount('/', memFs);
vfs.mount('/dev', new DeviceFsProvider({
  stdin: new NodeStdinHandler(),
  stdout: new NodeStdoutHandler(),
  stderr: new NodeStderrHandler(),
}));
const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(vfs, '/'));

const hostStdin = new InputStream(new NodeStdinHandler(), undefined, isatty(0));
const hostStdout = new OutputStream(new NodeStdoutHandler(), undefined, isatty(1));
const hostStderr = new OutputStream(new NodeStderrHandler(), undefined, isatty(2));

function createShellProcessImports(): Record<string, unknown> {
  const manager = new SimpleProcessManager({
    commandResolver: createCommandResolver({
      memFs: vfs,
      rootDescriptor,
      shellInstantiate: shellInstantiate as unknown as SyncInstantiateFn,
      shellCompileCore,
      coreutilsInstantiate: coreutilsInstantiate as unknown as SyncInstantiateFn,
      coreutilsCompileCore,
      createProcessImports: createShellProcessImports,
      registry,
    }),
    hostStreams: {
      stdin: hostStdin.dup(),
      stdout: hostStdout.dup(),
      stderr: hostStderr.dup(),
    },
  });

  return new WASIProcess({ manager }).getImportObject();
}

const shim = new WASIShim({
  sandbox: {
    preopens: { '/': rootDescriptor },
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)),
      PATH: '/usr/bin:/bin',
    },
    args: ['bash', ...process.argv.slice(2)],
    cwd: '/',
    stdin: hostStdin.dup(),
    stdout: hostStdout.dup(),
    stderr: hostStderr.dup(),
  },
});

const importObject = {
  ...shim.getImportObject(),
  ...createShellProcessImports(),
};

const { run } = (shellInstantiate as unknown as SyncInstantiateFn)(
  shellCompileCore,
  importObject,
  (mod, imports) => new WebAssembly.Instance(mod, imports),
);

try {
  process.exit(run.run());
} catch (e) {
  if (e instanceof ComponentExit) {
    process.exit(e.code);
  }
  throw e;
} finally {
  shim[Symbol.dispose]();
  registry[Symbol.dispose]();
  compilerWorker.terminate();
}

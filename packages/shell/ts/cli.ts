import { readFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { SimpleProcessManager } from '@mithic/process/manager/simple';
import { WorkerProcessManager } from '@mithic/process/manager/worker';
import type { CompileResult } from '@mithic/process/component/compiler';
import { WASIProcess } from '@mithic/process/instantiation';
import { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { MemoryFsProvider, DeviceFsProvider, SyncFileSystemRouter } from '@mithic/io/vfs';
import { NodeWorkerFactory } from '@mithic/io/io/worker-factory.node';
import { createComponentCompiler } from '@mithic/process/component/compiler';
import { CommandRegistry } from '@mithic/process/component/registry';
import { createCommandResolver, type SyncInstantiateFn } from './commands.ts';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { instantiate as shellInstantiate, modules as shellModules } from '@mithic/shell/component';
import { instantiate as coreutilsInstantiate, modules as coreutilsModules } from '@mithic/coreutils/component';
import { MithicShell, type SyncShellComponent } from './shell.ts';

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

const [shellPrecompiled, coreutilsPrecompiled, shellRawModules, coreutilsRawModules] = await Promise.all([
  compileModules(shellModules),
  compileModules(coreutilsModules),
  fetchModuleBytes(shellModules),
  fetchModuleBytes(coreutilsModules),
]);

const shellComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/shell/component')));
const coreutilsComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/coreutils/component')));
const shellJsSource = readFileSync(join(shellComponentDir, 'component.js'), 'utf-8');
const coreutilsJsSource = readFileSync(join(coreutilsComponentDir, 'component.js'), 'utf-8');

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
  new URL(import.meta.resolve('@mithic/process/worker/compiler.node')),
  { name: 'mithic-compiler' },
);
compilerWorker.postMessage({ type: '__port', port: compilerPort2 }, [compilerPort2 as unknown as Transferable]);
const compilerBridge = createComponentCompiler(compilerPort1 as unknown as MessagePort);
const registry = new CommandRegistry({
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

function resolveCommand(file: string): CompileResult | undefined {
  const name = file.includes('/') ? file.split('/').pop()! : file;
  if (name === 'sh' || name === 'bash') return shellCompileResult;
  if (COREUTILS_COMMANDS.has(name)) return coreutilsCompileResult;
  if (file.includes('/')) {
    try {
      const stat = vfs.stat(file);
      if (stat.mode & 0o111) {
        const handle = vfs.open(file, { read: true });
        try {
          const bytes = vfs.read(handle, 0, Number(stat.size));
          if (CommandRegistry.isWasmComponent(bytes)) {
            return registry.resolveBytes(bytes, file) ?? undefined;
          }
        } finally {
          vfs.close(handle);
        }
      }
    } catch { /* not found */ }
  }
  return undefined;
}

const workerManager = new WorkerProcessManager({
  resolveCommand,
  workerFactory,
  processWorkerUrl: new URL(import.meta.resolve('@mithic/process/worker/process.node')),
  maxWorkers: 8,
});

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

const shell = new MithicShell({
  wasi: {
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
  },
  process: {
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
  },
  syncComponent: {
    instantiate: shellInstantiate as unknown as SyncShellComponent['instantiate'],
    compileCore: shellCompileCore,
  },
});

try {
  process.exit(shell.runSync());
} finally {
  shell[Symbol.dispose]();
  workerManager[Symbol.dispose]();
  registry[Symbol.dispose]();
  compilerWorker.terminate();
}

import { readFile } from 'node:fs/promises';
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
import { createCommandResolver } from './commands.ts';

const componentUrl = new URL('../dist/wasm/component.js', import.meta.url);
const coreutilsUrl = new URL('../../coreutils/dist/wasm/component.js', import.meta.url);

const memFs = new MemoryFsProvider();
memFs.mkdir('/tmp');
const vfs = new SyncFileSystemRouter();
vfs.mount('/', memFs);
vfs.mount('/dev', new DeviceFsProvider());
const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(vfs, '/'));

const coreNames = ['component.core.wasm', 'component.core2.wasm', 'component.core3.wasm'];
const precompiledModules = new Map<string, WebAssembly.Module>();
await Promise.all(
  coreNames.map(async (name) => {
    const bytes = await readFile(new URL(name, componentUrl));
    precompiledModules.set(name, await WebAssembly.compile(bytes));
  }),
);

const coreutilsCoreNames = ['component.core.wasm', 'component.core2.wasm', 'component.core3.wasm'];
const coreutilsModules = new Map<string, WebAssembly.Module>();
await Promise.all(
  coreutilsCoreNames.map(async (name) => {
    try {
      const bytes = await readFile(new URL(name, coreutilsUrl));
      coreutilsModules.set(name, await WebAssembly.compile(bytes));
    } catch { /* some core files may not exist */ }
  }),
);

const { instantiate } = await import(componentUrl.toString());
const { instantiate: instantiateCoreutils } = await import(coreutilsUrl.toString());

function syncLoader(path: string): WebAssembly.Module {
  const mod = precompiledModules.get(path);
  if (!mod) throw new Error(`Module not precompiled: ${path}`);
  return mod;
}

function coreutilsSyncLoader(path: string): WebAssembly.Module {
  const mod = coreutilsModules.get(path);
  if (!mod) throw new Error(`Coreutils module not precompiled: ${path}`);
  return mod;
}

function syncInstantiator(module: WebAssembly.Module, imports: object): WebAssembly.Instance {
  return new WebAssembly.Instance(module, imports as WebAssembly.Imports);
}

const hostStdin = new InputStream(new NodeStdinHandler(), undefined, isatty(0));
const hostStdout = new OutputStream(new NodeStdoutHandler(), undefined, isatty(1));
const hostStderr = new OutputStream(new NodeStderrHandler(), undefined, isatty(2));

function createShellProcessImports(): Record<string, unknown> {
  const manager = new SimpleProcessManager({
    commandResolver: createCommandResolver({
      memFs: vfs,
      rootDescriptor,
      shellInstantiate: instantiate,
      shellSyncLoader: syncLoader,
      coreutilsInstantiate: instantiateCoreutils,
      coreutilsSyncLoader: coreutilsSyncLoader,
      syncInstantiator,
      createProcessImports: createShellProcessImports,
    }),
    hostStreams: {
      stdin: new NodeStdinHandler(),
      stdout: new NodeStdoutHandler(),
      stderr: new NodeStderrHandler(),
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

const { run } = await instantiate(
  async (path: string) => WebAssembly.compile(await readFile(new URL(path, componentUrl))),
  importObject,
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
}

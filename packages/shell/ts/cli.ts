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

const memFs = new MemoryFsProvider();
memFs.mkdir('/tmp');
const vfs = new SyncFileSystemRouter();
vfs.mount('/', memFs);
vfs.mount('/dev', new DeviceFsProvider());
const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(vfs, '/'));

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
}

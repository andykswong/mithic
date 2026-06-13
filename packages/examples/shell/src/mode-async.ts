import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { WASIShim } from '@mithic/wasip2/instantiation';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { FsDescriptorHandler } from '@mithic/wasip2/filesystem/fs-handler';
import { WASIProcess } from '@mithic/process/instantiation';
import { SimpleProcessManager, type CommandHandler, type CommandResolver, type CommandContext } from '@mithic/process/manager/simple';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { installPolyfill, createInstantiateCore } from '@mithic/wasm-transpile/asyncify';
import type { ProcessManager } from '@mithic/process/types';
import type { InputStreamHandler, OutputStreamHandler } from '@mithic/io/io';
import type { FileSystemRouter } from '@mithic/io/vfs';
import { ENV } from './shell.ts';

interface Stdio {
  stdin: InputStreamHandler;
  stdout: OutputStreamHandler;
  stderr: OutputStreamHandler;
}

export async function createAsyncManager(vfs: FileSystemRouter, stdio: Stdio): Promise<ProcessManager> {
  const polyfill = installPolyfill();
  const variant = polyfill.installed ? 'asyncify' : 'jspi';

  const [shellEntry, coreutilsEntry, rustComponentEntry] = await Promise.all([
    variant === 'asyncify'
      ? import('@mithic/shell/component/asyncify')
      : import('@mithic/shell/component/jspi'),
    variant === 'asyncify'
      ? import('@mithic/coreutils/component/asyncify')
      : import('@mithic/coreutils/component/jspi'),
    variant === 'asyncify'
      ? import('@mithic/example-rust-component/component/asyncify')
      : import('@mithic/example-rust-component/component/jspi'),
  ]);

  function compileModules(modules: Record<string, string>) {
    return async (path: string) => {
      const response = await fetch(modules[path]);
      return WebAssembly.compile(await response.arrayBuffer());
    };
  }

  const hostStdin = new InputStream(stdio.stdin, undefined, true);
  const hostStdout = new OutputStream(stdio.stdout, undefined, true);
  const hostStderr = new OutputStream(stdio.stderr, undefined, true);

  const manager = new SimpleProcessManager({
    hostStreams: { stdin: hostStdin, stdout: hostStdout, stderr: hostStderr },
    env: ENV,
  });

  const instantiateCore = createInstantiateCore({ asyncify: polyfill.installed });

  function createHandler(entry: { instantiate: Function; modules: Record<string, string> }): CommandHandler {
    return async (args: string[], ctx: CommandContext): Promise<number> => {
      const shim = new WASIShim({
        async: true,
        sandbox: {
          preopens: { '/': new Descriptor(new FsDescriptorHandler(vfs, '/')) },
          env: ctx.env,
          args,
          cwd: ctx.cwd,
          stdin: ctx.stdin,
          stdout: ctx.stdout,
          stderr: ctx.stderr,
        },
      });

      const proc = new WASIProcess({ manager });

      try {
        const instance = await entry.instantiate(
          compileModules(entry.modules),
          { ...shim.getImportObject(), ...proc.getImportObject() },
          instantiateCore,
        );
        return await instance.run.run();
      } catch (e: unknown) {
        if (e && typeof e === 'object' && 'tag' in e && (e as unknown as { tag: string }).tag === 'exit') {
          return (e as unknown as { val: number }).val ?? 1;
        }
        throw e;
      } finally {
        shim[Symbol.dispose]();
      }
    };
  }

  const shellHandler = createHandler(shellEntry as { instantiate: Function; modules: Record<string, string> });
  const coreutilsHandler = createHandler(coreutilsEntry as { instantiate: Function; modules: Record<string, string> });
  const rustComponentHandler = createHandler(rustComponentEntry as { instantiate: Function; modules: Record<string, string> });

  const commandResolver: CommandResolver = (file: string): CommandHandler | undefined => {
    const cmdName = file.includes('/') ? file.split('/').pop()! : file;
    if (cmdName === 'sh' || cmdName === 'bash') return shellHandler;
    if (COREUTILS_COMMANDS.has(cmdName)) return coreutilsHandler;
    if (cmdName === 'rust-component') return rustComponentHandler;
    return undefined;
  };

  manager.commandResolver = commandResolver;

  return manager;
}

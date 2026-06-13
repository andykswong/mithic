import { isatty } from 'node:tty';
import { installPolyfill, createInstantiateCore } from '@mithic/wasm-transpile';
import { NodeAsyncStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import type { ComponentExit } from '@mithic/wasip2/cli/exit';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { WASIShim } from '@mithic/wasip2/instantiation';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { FsDescriptorHandler } from '@mithic/wasip2/filesystem/fs-handler';
import { WASIProcess } from '@mithic/process/instantiation';
import { SimpleProcessManager, type CommandHandler, type CommandResolver, type CommandContext } from '@mithic/process/manager/simple';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { Runtime } from '../runtime.ts';
import { createNodeVfs, mountNodeVfs, getNodeEnv } from './shared.ts';

// --- Detect JSPI support and install polyfill ---

const polyfill = installPolyfill();
const variant = polyfill.installed ? 'asyncify' : 'jspi';

// --- Dynamically import the appropriate variant ---

const [shellEntry, coreutilsEntry] = await Promise.all([
  variant === 'asyncify'
    ? import('@mithic/shell/component/asyncify')
    : import('@mithic/shell/component/jspi'),
  variant === 'asyncify'
    ? import('@mithic/coreutils/component/asyncify')
    : import('@mithic/coreutils/component/jspi'),
]);

// --- Shared VFS ---

const { memFs, hostFs, vfs } = createNodeVfs();
await mountNodeVfs(vfs, memFs, hostFs);

// --- Module compiler helper ---

function compileModules(modules: Record<string, string>) {
  return async (path: string) => {
    const uri = modules[path];
    const response = await fetch(uri);
    return WebAssembly.compile(await response.arrayBuffer());
  };
}

// --- Create SimpleProcessManager and command resolver ---

const hostStdin = new InputStream(new NodeAsyncStdinHandler(), undefined, isatty(0));
const hostStdout = new OutputStream(new NodeStdoutHandler(), undefined, isatty(1));
const hostStderr = new OutputStream(new NodeStderrHandler(), undefined, isatty(2));

const env = { ...getNodeEnv(), TERM: process.env.TERM ?? 'xterm-256color' };

const manager = new SimpleProcessManager({
  hostStreams: { stdin: hostStdin, stdout: hostStdout, stderr: hostStderr },
  env,
});

const instantiateCore = createInstantiateCore({ asyncify: polyfill.installed });

type ComponentEntry = { instantiate: (...args: unknown[]) => Promise<{ run: { run: () => Promise<number> } }>; modules: Record<string, string> };

function createHandler(entry: ComponentEntry): CommandHandler {
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
      return (await instance.run.run()) ?? 0;
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'exitError' in e) {
        return (e as ComponentExit).code ?? 1;
      }
      throw e;
    } finally {
      shim[Symbol.dispose]();
    }
  };
}

const shellHandler = createHandler(shellEntry as unknown as ComponentEntry);
const coreutilsHandler = createHandler(coreutilsEntry as unknown as ComponentEntry);

const commandResolver: CommandResolver = (file: string): CommandHandler | undefined => {
  const cmdName = file.includes('/') ? file.split('/').pop()! : file;
  if (cmdName === 'sh' || cmdName === 'bash') return shellHandler;
  if (COREUTILS_COMMANDS.has(cmdName)) return coreutilsHandler;
  return undefined;
};

manager.commandResolver = commandResolver;

// --- Create Runtime and execute ---

const runtime = new Runtime({ manager, env, cwd: '/root' });

const proc = runtime.exec('bash', {
  args: process.argv.slice(2),
});
const exitCode = await runtime.waitAsync(proc);

runtime[Symbol.dispose]();
process.exit(exitCode);

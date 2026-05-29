import { readFile } from 'node:fs/promises';
import { isatty } from 'node:tty';
import { WASIShim } from '@mithic/wasip2';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { WASIProcess } from '@mithic/process/instantiation';
import { SimpleProcessManager } from '@mithic/process/impl/simple';
import { Process } from '@mithic/process/types';
import type { CommandContext } from '@mithic/process/impl/simple';
import type { SpawnOptions } from '@mithic/process/types';
import { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { MemoryFsProvider } from '@mithic/io/vfs';

const componentUrl = new URL('../dist/wasm/component.js', import.meta.url);
const coreutilsUrl = new URL('../../coreutils/dist/wasm/component.js', import.meta.url);

const COREUTILS_COMMANDS = new Set([
  'cat', 'head', 'tail', 'wc', 'grep', 'seq', 'sort', 'uniq',
  'tr', 'cut', 'tee', 'xargs', 'sleep', 'basename', 'dirname',
  'mkdir', 'rm', 'cp', 'mv', 'ls',
]);

const memFs = new MemoryFsProvider();
memFs.mkdir('/tmp');
const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(memFs, '/'));

// Pre-compile shell WASM modules at startup for synchronous child shell instantiation.
const coreNames = ['component.core.wasm', 'component.core2.wasm', 'component.core3.wasm'];
const precompiledModules = new Map<string, WebAssembly.Module>();
await Promise.all(
  coreNames.map(async (name) => {
    const bytes = await readFile(new URL(name, componentUrl));
    precompiledModules.set(name, await WebAssembly.compile(bytes));
  }),
);

// Pre-compile coreutils WASM modules at startup for synchronous instantiation.
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

// Pre-load the shell instantiate function once.
const { instantiate } = await import(componentUrl.toString());

// Pre-load the coreutils instantiate function once.
const { instantiate: instantiateCoreutils } = await import(coreutilsUrl.toString());

/** Synchronous WASM loader: returns a pre-compiled module by name. */
function syncLoader(path: string): WebAssembly.Module {
  const mod = precompiledModules.get(path);
  if (!mod) throw new Error(`Module not precompiled: ${path}`);
  return mod;
}

/** Synchronous coreutils WASM loader: returns a pre-compiled module by name. */
function coreutilsSyncLoader(path: string): WebAssembly.Module {
  const mod = coreutilsModules.get(path);
  if (!mod) throw new Error(`Coreutils module not precompiled: ${path}`);
  return mod;
}

/** Synchronous WASM instantiator: creates an instance synchronously. */
function syncInstantiator(module: WebAssembly.Module, imports: object): WebAssembly.Instance {
  return new WebAssembly.Instance(module, imports as WebAssembly.Imports);
}

let spawnIdCounter = 1_000_000;

// Shared host terminal streams (ref-counted via dup).
// Created once; each consumer calls .dup() to get its own handle.
const hostStdin = new InputStream(new NodeStdinHandler(), undefined, isatty(0));
const hostStdout = new OutputStream(new NodeStdoutHandler(), undefined, isatty(1));
const hostStderr = new OutputStream(new NodeStderrHandler(), undefined, isatty(2));

/** Run a child shell synchronously and return its exit code.
 * Uses synchronous WASM instantiation so the exit code is available before
 * returning, enabling Process.wait() to return a numeric value immediately.
 * Callers must ensure ctx.stdin/stdout/stderr are always defined. */
function runChildSync(args: string[], ctx: CommandContext): number {
  const childShim = new WASIShim({
    sandbox: {
      preopens: { '/': rootDescriptor },
      env: ctx.env,
      args: ['sh', ...args],
      cwd: '/',
      stdin: ctx.stdin,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    },
  });

  const childImports = {
    ...childShim.getImportObject(),
    ...createShellProcessImports(),
  };

  try {
    const { run } = instantiate(syncLoader, childImports, syncInstantiator) as { run: { run: () => number } };
    return run.run() ?? 0;
  } catch (e: unknown) {
    if (e instanceof ComponentExit) return e.code;
    return 1;
  } finally {
    childShim[Symbol.dispose]();
  }
}

/** Run a coreutils command synchronously and return its exit code. */
function runCoreutilSync(name: string, args: string[], ctx: CommandContext): number {
  const childShim = new WASIShim({
    sandbox: {
      preopens: { '/': rootDescriptor },
      env: ctx.env,
      args: [name, ...args],
      cwd: '/',
      stdin: ctx.stdin,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    },
  });

  try {
    const { run } = instantiateCoreutils(coreutilsSyncLoader, childShim.getImportObject(), syncInstantiator) as { run: { run: () => number } };
    return run.run() ?? 0;
  } catch (e: unknown) {
    if (e instanceof ComponentExit) return e.code;
    return 1;
  } finally {
    childShim[Symbol.dispose]();
  }
}

/** Create the mithic:process import object with a custom spawn that handles 'sh'
 * and all coreutils commands.
 * Intercepts 'sh' at every level to run child shells synchronously, ensuring
 * that Process.wait() returns the exit code before the WASM component resumes. */
function createShellProcessImports() {
  const manager = new SimpleProcessManager();
  const { createPipe, dupOutputStream } = new WASIProcess({ manager }).getImportObject()['mithic:process/manager'];

  const spawn = (file: string, args: string[], options?: SpawnOptions): Process => {
    const name = file.includes('/') ? file.split('/').pop()! : file;
    if (name === 'sh') {
      const pid = spawnIdCounter++;
      const rawEnv = options?.env as unknown;
      const env: Record<string, string> = Array.isArray(rawEnv)
        ? Object.fromEntries(rawEnv as [string, string][])
        : (rawEnv as Record<string, string> | undefined) ?? {};
      const ctx: CommandContext = {
        cwd: options?.cwd ?? '/',
        env,
        stdin: options?.stdin ?? hostStdin.dup(),
        stdout: options?.stdout ?? hostStdout.dup(),
        stderr: options?.stderr ?? hostStderr.dup(),
      };
      const exitCode = runChildSync(args, ctx);
      return new Process(pid, {
        wait: (): Promise<number> => exitCode as unknown as Promise<number>,
        tryWait: () => exitCode,
      });
    }
    if (COREUTILS_COMMANDS.has(name)) {
      const pid = spawnIdCounter++;
      const rawEnv = options?.env as unknown;
      const env: Record<string, string> = Array.isArray(rawEnv)
        ? Object.fromEntries(rawEnv as [string, string][])
        : (rawEnv as Record<string, string> | undefined) ?? {};
      const ctx: CommandContext = {
        cwd: options?.cwd ?? '/',
        env,
        stdin: options?.stdin ?? hostStdin.dup(),
        stdout: options?.stdout ?? hostStdout.dup(),
        stderr: options?.stderr ?? hostStderr.dup(),
      };
      const exitCode = runCoreutilSync(name, args, ctx);
      return new Process(pid, {
        wait: (): Promise<number> => exitCode as unknown as Promise<number>,
        tryWait: () => exitCode,
      });
    }
    throw Object.assign(new Error(`command not found: ${file}`), {
      payload: { tag: 'not-found' as const },
    });
  };

  return {
    'mithic:process/types': { Process },
    'mithic:process/manager': { spawn, createPipe, dupOutputStream },
  };
}

const shim = new WASIShim({
  sandbox: {
    preopens: { '/': rootDescriptor },
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)),
      PATH: '/usr/bin:/bin',
    },
    args: ['sh', ...process.argv.slice(2)],
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

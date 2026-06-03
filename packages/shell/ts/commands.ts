import { WASIShim } from '@mithic/wasip2';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import type { Descriptor } from '@mithic/wasip2/filesystem/types';
import type { CommandContext, CommandResolver } from '@mithic/process/manager/simple';
import type { SyncFileSystemProvider } from '@mithic/io/vfs';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { CommandRegistry, type CompileResult, type SyncInstantiateFn } from '@mithic/process/component/registry';
import { evalJcoSource } from '@mithic/process/component/eval-jco';
import { createChmodHandler } from './commands/chmod.ts';

export type { SyncInstantiateFn };

export interface CommandsConfig {
  memFs: SyncFileSystemProvider;
  rootDescriptor: Descriptor;
  shellInstantiate: SyncInstantiateFn;
  shellCompileCore: (path: string) => WebAssembly.Module;
  coreutilsInstantiate: SyncInstantiateFn;
  coreutilsCompileCore: (path: string) => WebAssembly.Module;
  createProcessImports: () => Record<string, unknown>;
  registry?: CommandRegistry;
}


const enc = new TextEncoder();

function writeError(ctx: CommandContext, msg: string): void {
  ctx.stderr.blockingWriteAndFlush(enc.encode(msg));
}

function syncInstantiateCore(module: WebAssembly.Module, imports: WebAssembly.Imports): WebAssembly.Instance {
  return new WebAssembly.Instance(module, imports);
}

export function createCommandResolver(config: CommandsConfig): CommandResolver {
  const { memFs } = config;

  function runComponent(
    instantiate: SyncInstantiateFn,
    compileCore: (path: string) => WebAssembly.Module,
    sandboxArgs: string[],
    ctx: CommandContext,
    extraImports?: Record<string, unknown>,
  ): number {
    const childShim = new WASIShim({
      sandbox: {
        preopens: { '/': config.rootDescriptor },
        env: ctx.env,
        args: sandboxArgs,
        cwd: '/',
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
      },
    });
    const childImports = {
      ...childShim.getImportObject(),
      ...(extraImports ?? config.createProcessImports()),
    };
    try {
      const { run } = instantiate(compileCore, childImports, syncInstantiateCore);
      return run.run() ?? 0;
    } catch (e: unknown) {
      if (e instanceof ComponentExit) return e.code;
      return 1;
    } finally {
      childShim[Symbol.dispose]();
    }
  }

  function runChildSync(args: string[], ctx: CommandContext, shellName = 'bash'): number {
    return runComponent(config.shellInstantiate, config.shellCompileCore, [shellName, ...args], ctx, config.createProcessImports());
  }

  function runCoreutilSync(name: string, args: string[], ctx: CommandContext): number {
    return runComponent(config.coreutilsInstantiate, config.coreutilsCompileCore, [name, ...args], ctx);
  }

  function readMemFile(path: string, size: bigint): Uint8Array {
    const handle = memFs.open(path, { read: true });
    try {
      return memFs.read(handle, 0, Number(size));
    } finally {
      memFs.close(handle);
    }
  }

  function runWasmComponent(result: CompileResult, path: string, args: string[], ctx: CommandContext): number {
    const jsSource = result.jsFiles?.['component.js'];
    if (!jsSource) {
      writeError(ctx, `${path}: compiled component missing JS wrapper\n`);
      return 126;
    }

    const instantiate = evalJcoSource(jsSource);

    // Compile core WASM modules
    const compiled = new Map<string, WebAssembly.Module>();
    for (const [modPath, wasmBytes] of Object.entries(result.modules)) {
      compiled.set(modPath, new WebAssembly.Module(wasmBytes.slice().buffer));
    }
    const compileCore = (modPath: string): WebAssembly.Module => {
      const mod = compiled.get(modPath);
      if (!mod) throw new Error(`Module not found: ${modPath}`);
      return mod;
    };

    return runComponent(instantiate, compileCore, [path, ...args], ctx, config.createProcessImports());
  }

  function tryRunWasm(bytes: Uint8Array, path: string, args: string[], ctx: CommandContext): number | null {
    if (!CommandRegistry.isWasmComponent(bytes)) return null;
    if (!config.registry) {
      writeError(ctx, `${path}: WASM execution not available (no compiler configured)\n`);
      return 126;
    }
    let result;
    try {
      result = config.registry.resolveBytes(bytes, path);
    } catch (e: unknown) {
      writeError(ctx, `${path}: ${e instanceof Error ? e.message : 'unknown error'}\n`);
      return 126;
    }
    if (!result) {
      writeError(ctx, `${path}: failed to compile WASM component\n`);
      return 126;
    }
    return runWasmComponent(result, path, args, ctx);
  }

  function runScriptSync(path: string, scriptArgs: string[], ctx: CommandContext): number {
    const stat = memFs.stat(path);
    if (!(stat.mode & 0o111)) {
      writeError(ctx, `${path}: permission denied\n`);
      return 126;
    }
    const bytes = readMemFile(path, stat.size);
    const wasmResult = tryRunWasm(bytes, path, scriptArgs, ctx);
    if (wasmResult !== null) return wasmResult;
    const text = new TextDecoder().decode(bytes);
    let interpreter = 'sh';
    let interpArgs: string[] = [];
    if (text.startsWith('#!')) {
      const firstLine = text.split('\n')[0].slice(2).trim();
      const parts = firstLine.split(/\s+/);
      interpreter = parts[0];
      interpArgs = parts.slice(1);
    }
    const interpName = interpreter.includes('/') ? interpreter.split('/').pop()! : interpreter;
    if (interpName === 'sh' || interpName === 'bash') {
      return runChildSync([...interpArgs, path, ...scriptArgs], ctx, interpName);
    }
    writeError(ctx, `${path}: ${interpreter}: interpreter not found\n`);
    return 127;
  }

  function resolveFromPath(file: string, args: string[], pathDirs: string[], ctx: CommandContext): number | null {
    const candidates = file.includes('/') ? [file] : pathDirs.map(d => `${d}/${file}`);
    for (const p of candidates) {
      try {
        const stat = memFs.stat(p);
        if (!(stat.mode & 0o111)) continue;
        const bytes = readMemFile(p, stat.size < 4n ? stat.size : 4n);
        if (CommandRegistry.isWasmComponent(bytes)) {
          const fullBytes = readMemFile(p, stat.size);
          const wasmResult = tryRunWasm(fullBytes, p, args, ctx);
          if (wasmResult !== null) return wasmResult;
        }
        return runScriptSync(p, args, ctx);
      } catch {
        continue;
      }
    }
    return null;
  }

  return (file: string) => {
    const name = file.includes('/') ? file.split('/').pop()! : file;

    if (name === 'sh' || name === 'bash') return (a: string[], c: CommandContext) => runChildSync(a, c, name);
    if (name === 'chmod') return createChmodHandler(memFs);
    if (COREUTILS_COMMANDS.has(name)) return (a: string[], c: CommandContext) => runCoreutilSync(name, a, c);

    if (file.includes('/')) {
      return (a: string[], c: CommandContext) => {
        try {
          return runScriptSync(file, a, c);
        } catch {
          throw Object.assign(new Error(`command not found: ${file}`), {
            payload: { tag: 'not-found' as const },
          });
        }
      };
    }

    return (a: string[], c: CommandContext) => {
      const pathDirs = (c.env['PATH'] ?? '/usr/bin:/bin').split(':').filter(Boolean);
      const result = resolveFromPath(file, a, pathDirs, c);
      if (result !== null) return result;
      throw Object.assign(new Error(`command not found: ${file}`), {
        payload: { tag: 'not-found' as const },
      });
    };
  };
}

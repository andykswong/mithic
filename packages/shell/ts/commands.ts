import { WASIShim } from '@mithic/wasip2';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import type { Descriptor } from '@mithic/wasip2/filesystem/types';
import type { CommandContext, CommandResolver } from '@mithic/process/impl/simple';
import type { SyncFileSystemProvider } from '@mithic/io/vfs';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';

export type SyncInstantiateFn = (
  compileCore: (path: string) => WebAssembly.Module,
  imports: object,
  instantiateCore: (module: WebAssembly.Module, imports: WebAssembly.Imports) => WebAssembly.Instance,
) => { run: { run: () => number } };

export interface CommandsConfig {
  memFs: SyncFileSystemProvider;
  rootDescriptor: Descriptor;
  shellInstantiate: SyncInstantiateFn;
  shellCompileCore: (path: string) => WebAssembly.Module;
  coreutilsInstantiate: SyncInstantiateFn;
  coreutilsCompileCore: (path: string) => WebAssembly.Module;
  createProcessImports: () => Record<string, unknown>;
}


const enc = new TextEncoder();

function syncInstantiateCore(module: WebAssembly.Module, imports: WebAssembly.Imports): WebAssembly.Instance {
  return new WebAssembly.Instance(module, imports);
}

export function createCommandResolver(config: CommandsConfig): CommandResolver {
  const { memFs } = config;

  function runChildSync(args: string[], ctx: CommandContext, shellName = 'bash'): number {
    const childShim = new WASIShim({
      sandbox: {
        preopens: { '/': config.rootDescriptor },
        env: ctx.env,
        args: [shellName, ...args],
        cwd: '/',
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
      },
    });
    const childImports = {
      ...childShim.getImportObject(),
      ...config.createProcessImports(),
    };
    try {
      const { run } = config.shellInstantiate(config.shellCompileCore, childImports, syncInstantiateCore);
      return run.run() ?? 0;
    } catch (e: unknown) {
      if (e instanceof ComponentExit) return e.code;
      return 1;
    } finally {
      childShim[Symbol.dispose]();
    }
  }

  function runCoreutilSync(name: string, args: string[], ctx: CommandContext): number {
    const childShim = new WASIShim({
      sandbox: {
        preopens: { '/': config.rootDescriptor },
        env: ctx.env,
        args: [name, ...args],
        cwd: '/',
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
      },
    });
    try {
      const { run } = config.coreutilsInstantiate(config.coreutilsCompileCore, childShim.getImportObject(), syncInstantiateCore);
      return run.run() ?? 0;
    } catch (e: unknown) {
      if (e instanceof ComponentExit) return e.code;
      return 1;
    } finally {
      childShim[Symbol.dispose]();
    }
  }

  function readMemFile(path: string, size: bigint): Uint8Array {
    const handle = memFs.open(path, { read: true });
    try {
      return memFs.read(handle, 0, Number(size));
    } finally {
      memFs.close(handle);
    }
  }

  function runScriptSync(path: string, scriptArgs: string[], ctx: CommandContext): number {
    const stat = memFs.stat(path);
    if (!(stat.mode & 0o111)) {
      ctx.stderr.blockingWriteAndFlush(enc.encode(`${path}: permission denied\n`));
      return 126;
    }
    const bytes = readMemFile(path, stat.size);
    if (bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
      ctx.stderr.blockingWriteAndFlush(enc.encode(`${path}: cannot execute WASM component synchronously\n`));
      return 126;
    }
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
    ctx.stderr.blockingWriteAndFlush(enc.encode(`${path}: ${interpreter}: interpreter not found\n`));
    return 127;
  }

  function resolveFromPath(file: string, args: string[], pathDirs: string[], ctx: CommandContext): number | null {
    const candidates = file.includes('/') ? [file] : pathDirs.map(d => `${d}/${file}`);
    for (const p of candidates) {
      try {
        const stat = memFs.stat(p);
        if (!(stat.mode & 0o111)) continue;
        const bytes = readMemFile(p, stat.size < 4n ? stat.size : 4n);
        if (bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
          ctx.stderr.blockingWriteAndFlush(enc.encode(`${p}: cannot execute WASM component synchronously\n`));
          return 126;
        }
        return runScriptSync(p, args, ctx);
      } catch {
        continue;
      }
    }
    return null;
  }

  function chmodHandler(args: string[], ctx: CommandContext): number {
    const isSymbolicMode = (a: string) => /^[ugoa]*[+\-=][rwxXst]*$/.test(a);
    const nonFlags = args.filter(a => !a.startsWith('-') || isSymbolicMode(a));
    const modeStr = nonFlags[0];
    const paths = nonFlags.slice(1);
    let exitCode = 0;
    if (!modeStr || paths.length === 0) {
      ctx.stderr.blockingWriteAndFlush(enc.encode('chmod: missing operand\n'));
      exitCode = 1;
    } else if (/^[0-7]+$/.test(modeStr)) {
      const mode = parseInt(modeStr, 8);
      for (const p of paths) {
        try { memFs.chmod(p, mode); } catch { exitCode = 1; }
      }
    } else {
      const match = /^([ugoa]*)([+\-=])([rwxXst]*)$/.exec(modeStr);
      if (!match) {
        ctx.stderr.blockingWriteAndFlush(enc.encode(`chmod: invalid mode: '${modeStr}'\n`));
        exitCode = 1;
      } else {
        const [, who, op, perms] = match;
        const targets = who === '' ? 'ugo' : who.replace('a', 'ugo');
        for (const p of paths) {
          try {
            const stat = memFs.stat(p);
            let mode = stat.mode;
            let bits = 0;
            if (perms.includes('r')) bits |= 0o444;
            if (perms.includes('w')) bits |= 0o222;
            if (perms.includes('x') || perms.includes('X')) bits |= 0o111;
            let mask = 0;
            if (targets.includes('u')) mask |= 0o700;
            if (targets.includes('g')) mask |= 0o070;
            if (targets.includes('o')) mask |= 0o007;
            bits &= mask;
            if (op === '+') mode |= bits;
            else if (op === '-') mode &= ~bits;
            else mode = (mode & ~mask) | bits;
            memFs.chmod(p, mode);
          } catch { exitCode = 1; }
        }
      }
    }
    return exitCode;
  }

  return (file: string) => {
    const name = file.includes('/') ? file.split('/').pop()! : file;

    if (name === 'sh' || name === 'bash') return (a: string[], c: CommandContext) => runChildSync(a, c, name);
    if (name === 'chmod') return chmodHandler;
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

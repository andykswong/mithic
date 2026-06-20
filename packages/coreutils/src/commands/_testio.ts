/**
 * Shared test harness for file-operation command unit tests.
 *
 * Builds a {@link CommandIO} whose `fs/*` syscalls are serviced by a real
 * {@link MemoryFsProvider} (the same provider the kernel mounts), so command
 * logic is exercised against faithful VFS semantics without booting a kernel.
 * Mirrors the kernel's SyscallDispatcher fs handling (the argument/result
 * shapes the commands rely on).
 */
import { MemoryFsProvider } from '@mithic/io/vfs';
import type { FileHandle } from '@mithic/io/vfs';
import type { CommandIO } from '../harness.ts';

export interface TestHarness {
  io: CommandIO;
  out(): string;
  err(): string;
  fs: MemoryFsProvider;
}

/** One observed `process/pipeline` spawn (used to assert -exec / xargs behavior). */
export interface SpawnRecord { stages: Array<{ path: string; argv: string[] }>; }

export function makeIO(opts: {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinText?: string;
  files?: Record<string, string | Uint8Array | { content: string | Uint8Array; mode?: number; mtime?: Date }>;
  pid?: number;
  /**
   * Optional handler for `process/pipeline` spawns. Receives each spawn's stages
   * and returns the child stdout (string) and per-stage exit codes. Every spawn
   * is also recorded in {@link TestHarness} via the closure the test passes in.
   * When omitted, `process/pipeline` throws ENOSYS (the default fs-only harness).
   */
  onSpawn?: (rec: SpawnRecord) => { stdout?: string; exitCodes?: number[] };
}): TestHarness {
  const enc = new TextEncoder();
  const fs = new MemoryFsProvider({ files: opts.files });

  const stdin = new ReadableStream<Uint8Array>({
    start(c) { if (opts.stdinText) c.enqueue(enc.encode(opts.stdinText)); c.close(); },
  });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });

  // Kernel-side fd table: maps a guest fd to a provider FileHandle + offset.
  const open = new Map<number, { handle: FileHandle; offset: number }>();
  let nextFd = 3;
  const cwd = opts.cwd ?? '/';

  const resolve = (p: string): string => {
    const path = String(p);
    if (path.startsWith('/')) return path;
    return cwd.endsWith('/') ? cwd + path : cwd + '/' + path;
  };

  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    const path = args.path !== undefined ? resolve(String(args.path)) : undefined;
    switch (call) {
      case 'fs/open': {
        const handle = await fs.open(path!, (args.oflags ?? {}) as Record<string, boolean>);
        const fd = nextFd++;
        open.set(fd, { handle, offset: 0 });
        return { fd };
      }
      case 'fs/read': {
        const e = open.get(Number(args.fd))!;
        const data = await fs.read(e.handle, e.offset, Number(args.len ?? 0));
        e.offset += data.byteLength;
        return new Uint8Array(data);
      }
      case 'fs/write': {
        const e = open.get(Number(args.fd))!;
        const data = args.data as Uint8Array;
        const written = await fs.write(e.handle, data, e.offset);
        e.offset += written;
        return { written };
      }
      case 'fs/close': {
        const e = open.get(Number(args.fd));
        if (e) { await fs.close(e.handle); open.delete(Number(args.fd)); }
        return {};
      }
      case 'fs/stat': {
        const s = await fs.stat(path!, { followSymlinks: args.followSymlinks !== false });
        return { ...s, size: Number(s.size), linkCount: Number(s.linkCount) };
      }
      case 'fs/readdir': return await fs.readdir(path!);
      case 'fs/mkdir': await fs.mkdir(path!); return {};
      case 'fs/rmdir': await fs.rmdir(path!); return {};
      case 'fs/unlink': await fs.unlink(path!); return {};
      case 'fs/rename': await fs.rename(path!, resolve(String(args.newPath))); return {};
      case 'fs/symlink': await fs.symlink(String(args.target), path!); return {};
      case 'fs/readlink': return { target: await fs.readlink(path!) };
      case 'fs/link': await fs.link(resolve(String(args.target)), path!); return {};
      case 'fs/chmod': await fs.chmod(path!, Number(args.mode)); return {};
      case 'fs/utimes': {
        const now = Date.now();
        await fs.utimes(path!, new Date(typeof args.atime === 'number' ? args.atime : now), new Date(typeof args.mtime === 'number' ? args.mtime : now));
        return {};
      }
      case 'fs/realpath': return { path: fs.realpath(path!) };
      case 'process/getpid': return { pid: opts.pid ?? 7 };
      case 'process/pipeline': {
        if (!opts.onSpawn) throw Object.assign(new Error('process/pipeline'), { code: 'ENOSYS' });
        const stages = (args.stages ?? []) as Array<{ path: string; argv: string[] }>;
        const r = opts.onSpawn({ stages });
        return { exitCodes: r.exitCodes ?? stages.map(() => 0), stdout: enc.encode(r.stdout ?? '') };
      }
      default: throw Object.assign(new Error(`unexpected syscall ${call}`), { code: 'ENOSYS' });
    }
  };

  const decode = (chunks: Uint8Array[]): string => {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(buf);
  };

  // Translate VFS FileSystemError codes to errno on the way out (the kernel does
  // this; commands inspect `.code`). MemoryFsProvider throws FileSystemError.
  const wrapped: CommandIO['syscall'] = async (call, args) => {
    try { return await syscall(call, args); }
    catch (e) { throw toErrno(e); }
  };

  return {
    io: { args: opts.args, env: opts.env ?? {}, cwd, stdin, stdout, stderr, syscall: wrapped },
    out: () => decode(outChunks),
    err: () => decode(errChunks),
    fs,
  };
}

const FS_ERRNO: Record<string, string> = {
  'no-entry': 'ENOENT', 'exist': 'EEXIST', 'not-directory': 'ENOTDIR', 'is-directory': 'EISDIR',
  'not-empty': 'ENOTEMPTY', 'invalid': 'EINVAL', 'access': 'EACCES', 'not-permitted': 'EPERM',
  'cross-device': 'EXDEV', 'loop': 'ELOOP', 'io': 'EIO',
};

function toErrno(e: unknown): unknown {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = (e as { code: string }).code;
    const errno = FS_ERRNO[code] ?? code;
    return Object.assign(e as object, { code: errno });
  }
  return e;
}

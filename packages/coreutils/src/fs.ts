/**
 * Shared filesystem helpers for the file-operation coreutils.
 *
 * Every file command reaches the VFS through the kernel `fs/*` syscalls on a
 * {@link CommandIO}. This module centralizes the request/response shapes (so a
 * single place knows that `fs/stat` returns `{ type, size, mode, mtime, … }`
 * and `fs/readlink` returns `{ target }`), plus the pure POSIX path arithmetic
 * (`basename` / `dirname` / `joinPath` / `normalize`) the commands share.
 *
 * Helpers throw on error (the underlying syscall rejects with an `errno`-tagged
 * Error); callers catch and translate to coreutils-style stderr messages.
 */
import type { CommandIO } from './harness.ts';

/** A filesystem entry kind, mirroring the VFS `DescriptorType`. */
export type FileType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'block-device'
  | 'character-device'
  | 'fifo'
  | 'socket'
  | 'unknown';

/** Stat result as delivered over the `fs/stat` syscall (size/linkCount as numbers). */
export interface StatResult {
  type: FileType;
  size: number;
  mode: number;
  mtime: string | number | Date;
  atime: string | number | Date;
  ctime: string | number | Date;
  linkCount: number;
}

/** A directory entry from `fs/readdir`. */
export interface DirEntry {
  name: string;
  type: FileType;
}

/** The `errno` code carried by a rejected syscall, if any. */
export function errnoOf(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

/** True if the error is a "no such file or directory" (ENOENT). */
export function isENOENT(err: unknown): boolean {
  return errnoOf(err) === 'ENOENT';
}

/**
 * `fs/stat` a path. `follow` controls symlink following: `true` (default) =
 * stat the target (stat(2)); `false` = stat the link itself (lstat(2)).
 */
export async function stat(io: CommandIO, path: string, follow = true): Promise<StatResult> {
  return (await io.syscall('fs/stat', { dirfd: AT_FDCWD, path, followSymlinks: follow })) as StatResult;
}

/** `fs/readdir` a directory, returning its entries (excludes `.`/`..`). */
export async function readdir(io: CommandIO, path: string): Promise<DirEntry[]> {
  return (await io.syscall('fs/readdir', { dirfd: AT_FDCWD, path })) as DirEntry[];
}

/** Read a whole file's bytes via `fs/open`/`fs/read`/`fs/close`. */
export async function readFile(io: CommandIO, path: string): Promise<Uint8Array> {
  const { fd } = (await io.syscall('fs/open', { dirfd: AT_FDCWD, path, oflags: { read: true } })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/**
 * Write `bytes` to `path`, truncating/creating. `mode` is applied via `fs/chmod`
 * after the write when provided (the VFS open path always creates with 0o644).
 */
export async function writeFile(io: CommandIO, path: string, bytes: Uint8Array, mode?: number): Promise<void> {
  const { fd } = (await io.syscall('fs/open', {
    dirfd: AT_FDCWD, path, oflags: { write: true, create: true, truncate: true },
  })) as { fd: number };
  try {
    let off = 0;
    // Write in chunks so very large files don't blow a single message.
    while (off < bytes.byteLength) {
      const slice = bytes.subarray(off, off + 65536);
      const { written } = (await io.syscall('fs/write', { fd, data: slice })) as { written: number };
      if (written <= 0) break;
      off += written;
    }
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
  if (mode !== undefined) await io.syscall('fs/chmod', { dirfd: AT_FDCWD, path, mode });
}

/** Create an empty file (used by touch). Returns false if the parent is missing. */
export async function createFile(io: CommandIO, path: string): Promise<void> {
  const { fd } = (await io.syscall('fs/open', {
    dirfd: AT_FDCWD, path, oflags: { write: true, create: true },
  })) as { fd: number };
  await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
}

export const mkdir = (io: CommandIO, path: string): Promise<unknown> =>
  io.syscall('fs/mkdir', { dirfd: AT_FDCWD, path });
export const rmdir = (io: CommandIO, path: string): Promise<unknown> =>
  io.syscall('fs/rmdir', { dirfd: AT_FDCWD, path });
export const unlink = (io: CommandIO, path: string): Promise<unknown> =>
  io.syscall('fs/unlink', { dirfd: AT_FDCWD, path });
export const rename = (io: CommandIO, from: string, to: string): Promise<unknown> =>
  io.syscall('fs/rename', { dirfd: AT_FDCWD, path: from, newPath: to });
export const symlink = (io: CommandIO, target: string, path: string): Promise<unknown> =>
  io.syscall('fs/symlink', { dirfd: AT_FDCWD, target, path });
export const link = (io: CommandIO, target: string, path: string): Promise<unknown> =>
  io.syscall('fs/link', { dirfd: AT_FDCWD, target, path });
export const chmod = (io: CommandIO, path: string, mode: number): Promise<unknown> =>
  io.syscall('fs/chmod', { dirfd: AT_FDCWD, path, mode });
export const utimes = (io: CommandIO, path: string, atime: number, mtime: number): Promise<unknown> =>
  io.syscall('fs/utimes', { dirfd: AT_FDCWD, path, atime, mtime });

export async function readlink(io: CommandIO, path: string): Promise<string> {
  const { target } = (await io.syscall('fs/readlink', { dirfd: AT_FDCWD, path })) as { target: string };
  return target;
}

export async function realpath(io: CommandIO, path: string): Promise<string> {
  const { path: resolved } = (await io.syscall('fs/realpath', { dirfd: AT_FDCWD, path })) as { path: string };
  return resolved;
}

/** Stat a path and return its type, or `undefined` if it does not exist. */
export async function typeOf(io: CommandIO, path: string, follow = true): Promise<FileType | undefined> {
  try {
    return (await stat(io, path, follow)).type;
  } catch (e) {
    if (isENOENT(e)) return undefined;
    throw e;
  }
}

export async function exists(io: CommandIO, path: string, follow = true): Promise<boolean> {
  return (await typeOf(io, path, follow)) !== undefined;
}

export async function isDir(io: CommandIO, path: string): Promise<boolean> {
  return (await typeOf(io, path)) === 'directory';
}

// ── pure path arithmetic (POSIX) ───────────────────────────────────────────

/** AT_FDCWD: resolve relative paths against the process cwd in the kernel. */
export const AT_FDCWD = -100;

/** Strip a trailing slash (keeping root `/`). */
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p;
}

/** POSIX `basename`: last path component. `basename('/a/b/') === 'b'`. */
export function basename(path: string): string {
  const p = stripTrailingSlash(path);
  if (p === '/' || p === '') return p === '' ? '' : '/';
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** POSIX `dirname`: everything but the last component. `dirname('/a/b') === '/a'`. */
export function dirname(path: string): string {
  const p = stripTrailingSlash(path);
  const i = p.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return p.slice(0, i);
}

/** Join a directory and a name into a single path (avoids double slashes). */
export function joinPath(dir: string, name: string): string {
  if (dir === '' || dir === '.') return name;
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

/** Normalize a path, collapsing `.`/`..` segments. Relative paths gain no root. */
export function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const parts = path.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else {
      out.push(part);
    }
  }
  const joined = out.join('/');
  if (absolute) return '/' + joined;
  return joined === '' ? '.' : joined;
}

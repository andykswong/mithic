/**
 * B3 — a File System Access API façade over the `fs/*` syscalls.
 *
 * ARCHITECTURAL INVARIANT: the wire format is unchanged. The kernel still speaks
 * `fs/open`+`fs/read`+`fs/write`+`fs/close`+`fs/stat`+`fs/mkdir`+`fs/readdir`+
 * `fs/unlink`+`fs/rmdir` over the stringly-typed syscall envelope. This module is
 * a pure ADAPTER (Dependency Inversion): guest code depends on the standard
 * WHATWG `FileSystemDirectoryHandle`/`FileSystemFileHandle`/
 * `FileSystemWritableFileStream` shapes; the integer fd is an INTERNAL detail of
 * each handle and is never surfaced.
 *
 * HONEST SCOPE: the value is a clean typed standard surface for FUTURE guests
 * (image-viewer, notebook, third-party processes). It does NOT replace the
 * shell's `makeFsClient` — the executor's redirect machinery is synchronous-
 * looking and cannot drop the async handle API behind it. This is purely
 * additive.
 *
 * The shapes match the web FSA API closely enough that guest code written
 * against `FileSystemDirectoryHandle`/`FileSystemFileHandle` works unchanged:
 * `getFileHandle(name,{create})`, `getDirectoryHandle(name,{create})`,
 * `removeEntry(name)`, `getFile()`, `createWritable()`, `keys()`/`values()`/
 * `entries()` async iterators, and `write()`/`close()` on the writable.
 */
import { INITIAL_CREDIT_BYTES } from '@mithic/protocol';
import type { SyscallHook } from './fetch.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Chunk size for streaming reads in `getFile().stream()`. */
const READ_CHUNK_BYTES = INITIAL_CREDIT_BYTES;

/** The `fs/stat` wire result the kernel returns (numbers, not BigInt). */
interface StatResult {
  type: 'file' | 'directory' | string;
  size: number;
}

/** The `fs/readdir` wire result entry. */
interface DirEntryResult {
  name: string;
  type: 'file' | 'directory' | string;
}

/** Join a directory path and a child name into a normalized absolute path. */
function joinPath(dir: string, name: string): string {
  if (name.includes('/')) throw typeError(`name must not contain "/": ${name}`);
  if (name === '' || name === '.' || name === '..') throw typeError(`invalid name: ${name}`);
  const base = dir === '/' ? '' : dir;
  return `${base}/${name}`;
}

function typeError(message: string): TypeError {
  return new TypeError(message);
}

/** Build a DOM `NotFoundError` (FSA throws this for a missing entry without `create`). */
function notFound(message: string): DOMException {
  return new DOMException(message, 'NotFoundError');
}

function errnoOf(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// File / Blob-like value returned by getFile()
// ---------------------------------------------------------------------------

/**
 * A `File`/`Blob`-shaped value backed by the VFS. `.stream()` pulls `fs/read`
 * chunks into a `ReadableStream`; `.text()`/`.arrayBuffer()` materialize the
 * whole file. The fd is opened lazily per read so the value is re-readable.
 */
export class GuestFile {
  readonly name: string;
  readonly size: number;
  readonly type = '';
  readonly lastModified: number;
  #syscall: SyscallHook;
  #path: string;

  constructor(syscall: SyscallHook, path: string, name: string, size: number, lastModified: number) {
    this.#syscall = syscall;
    this.#path = path;
    this.name = name;
    this.size = size;
    this.lastModified = lastModified;
  }

  /** Stream the file's bytes by repeatedly issuing `fs/read` until EOF. */
  stream(): ReadableStream<Uint8Array> {
    const syscall = this.#syscall;
    const path = this.#path;
    let fd: number | undefined;
    return new ReadableStream<Uint8Array>({
      async start() {
        const opened = (await syscall('fs/open', { path, oflags: { read: true } })) as { fd: number };
        fd = opened.fd;
      },
      async pull(controller) {
        try {
          const data = await readFsChunk(syscall, fd!, READ_CHUNK_BYTES);
          if (data.byteLength === 0) {
            controller.close();
            await syscall('fs/close', { fd: fd! }).catch(() => { /* best effort */ });
            return;
          }
          controller.enqueue(data);
        } catch (e) {
          controller.error(e);
          await syscall('fs/close', { fd: fd! }).catch(() => { /* best effort */ });
        }
      },
      async cancel() {
        if (fd !== undefined) await syscall('fs/close', { fd }).catch(() => { /* best effort */ });
      },
    });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes();
    // Return a tight ArrayBuffer copy (the bytes may be a subarray view).
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return dec.decode(await this.bytes());
  }

  /** Materialize the whole file into one Uint8Array (drains `stream()`). */
  async bytes(): Promise<Uint8Array> {
    const reader = this.stream().getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); total += value.byteLength; }
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }
}

/** Issue one `fs/read` and normalize the wire result to a Uint8Array. */
async function readFsChunk(syscall: SyscallHook, fd: number, len: number): Promise<Uint8Array> {
  const result = await syscall('fs/read', { fd, len });
  // The kernel returns the bytes directly; tolerate a `{data}` wrapper too.
  if (result instanceof Uint8Array) return result;
  if (result && typeof result === 'object' && 'data' in result) {
    const data = (result as { data: unknown }).data;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
  }
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  return new Uint8Array();
}

// ---------------------------------------------------------------------------
// Writable file stream returned by createWritable()
// ---------------------------------------------------------------------------

/** Data accepted by {@link GuestWritableFileStream.write}. */
export type WritableChunk = Uint8Array | ArrayBuffer | string | { type: 'write'; data: Uint8Array | ArrayBuffer | string };

/**
 * A `FileSystemWritableFileStream`-shaped writable that flushes via `fs/write`.
 * Opened with `{create, write, truncate}` by default so it overwrites, matching
 * the FSA `createWritable({keepExistingData:false})` default. `write()` appends
 * at the current offset; `close()` releases the fd.
 */
export class GuestWritableFileStream {
  #syscall: SyscallHook;
  #fd: number;
  #offset = 0;
  #closed = false;

  constructor(syscall: SyscallHook, fd: number) {
    this.#syscall = syscall;
    this.#fd = fd;
  }

  async write(chunk: WritableChunk): Promise<void> {
    if (this.#closed) throw typeError('write on a closed writable stream');
    const data = toBytes(unwrapWrite(chunk));
    let off = 0;
    while (off < data.byteLength) {
      const slice = data.subarray(off, off + 65536);
      const { written } = (await this.#syscall('fs/write', { fd: this.#fd, data: slice, offset: this.#offset })) as { written: number };
      const n = written > 0 ? written : slice.byteLength;
      off += n;
      this.#offset += n;
    }
    // An explicit zero-byte write still touches the file (create-only writers).
    if (data.byteLength === 0) {
      await this.#syscall('fs/write', { fd: this.#fd, data: new Uint8Array(), offset: this.#offset });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#syscall('fs/close', { fd: this.#fd }).catch(() => { /* best effort */ });
  }

  /** Abort the writable, releasing the fd without further writes. */
  async abort(): Promise<void> {
    return this.close();
  }
}

/** Unwrap an FSA `{type:'write', data}` command to its bytes/string payload. */
function unwrapWrite(chunk: WritableChunk): Uint8Array | ArrayBuffer | string {
  if (chunk && typeof chunk === 'object' && !(chunk instanceof Uint8Array) && !(chunk instanceof ArrayBuffer) && 'data' in chunk) {
    return (chunk as { data: Uint8Array | ArrayBuffer | string }).data;
  }
  return chunk as Uint8Array | ArrayBuffer | string;
}

function toBytes(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

// ---------------------------------------------------------------------------
// File handle
// ---------------------------------------------------------------------------

/** A `FileSystemFileHandle`-shaped handle. The backing path/fd is internal. */
export class GuestFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  #syscall: SyscallHook;
  #path: string;

  constructor(syscall: SyscallHook, path: string, name: string) {
    this.#syscall = syscall;
    this.#path = path;
    this.name = name;
  }

  /** Get a `File`/`Blob`-like snapshot (stat for size, then lazy reads). */
  async getFile(): Promise<GuestFile> {
    const stat = (await this.#syscall('fs/stat', { path: this.#path })) as StatResult;
    return new GuestFile(this.#syscall, this.#path, this.name, stat.size ?? 0, Date.now());
  }

  /**
   * Open a writable stream over this file. Truncates by default (FSA's
   * `keepExistingData:false`); pass `{keepExistingData:true}` to preserve and
   * append from offset 0 instead.
   */
  async createWritable(options: { keepExistingData?: boolean } = {}): Promise<GuestWritableFileStream> {
    const truncate = options.keepExistingData !== true;
    const { fd } = (await this.#syscall('fs/open', {
      path: this.#path,
      oflags: { create: true, write: true, truncate },
    })) as { fd: number };
    return new GuestWritableFileStream(this.#syscall, fd);
  }
}

// ---------------------------------------------------------------------------
// Directory handle
// ---------------------------------------------------------------------------

/** Options for {@link GuestDirectoryHandle.getFileHandle}/`getDirectoryHandle`. */
export interface GetHandleOptions {
  create?: boolean;
}

/** A `FileSystemDirectoryHandle`-shaped handle over a VFS directory. */
export class GuestDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  #syscall: SyscallHook;
  #path: string;

  constructor(syscall: SyscallHook, path: string, name: string) {
    this.#syscall = syscall;
    this.#path = path;
    this.name = name;
  }

  async getFileHandle(name: string, options: GetHandleOptions = {}): Promise<GuestFileHandle> {
    const childPath = joinPath(this.#path, name);
    const existing = await this.#statKind(childPath);
    if (existing === 'file') return new GuestFileHandle(this.#syscall, childPath, name);
    if (existing === 'directory') throw new DOMException(`${name} is a directory`, 'TypeMismatchError');
    if (!options.create) throw notFound(`no such file: ${name}`);
    // Create the file by opening it create+write+truncate, then closing.
    const { fd } = (await this.#syscall('fs/open', {
      path: childPath,
      oflags: { create: true, write: true, truncate: true },
    })) as { fd: number };
    await this.#syscall('fs/close', { fd }).catch(() => { /* best effort */ });
    return new GuestFileHandle(this.#syscall, childPath, name);
  }

  async getDirectoryHandle(name: string, options: GetHandleOptions = {}): Promise<GuestDirectoryHandle> {
    const childPath = joinPath(this.#path, name);
    const existing = await this.#statKind(childPath);
    if (existing === 'directory') return new GuestDirectoryHandle(this.#syscall, childPath, name);
    if (existing === 'file') throw new DOMException(`${name} is a file`, 'TypeMismatchError');
    if (!options.create) throw notFound(`no such directory: ${name}`);
    await this.#syscall('fs/mkdir', { path: childPath });
    return new GuestDirectoryHandle(this.#syscall, childPath, name);
  }

  /** Remove a child entry. `{recursive}` is accepted for API parity. */
  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const childPath = joinPath(this.#path, name);
    const kind = await this.#statKind(childPath);
    if (kind === undefined) throw notFound(`no such entry: ${name}`);
    if (kind === 'directory') {
      if (options.recursive) await this.#removeRecursive(childPath);
      else await this.#syscall('fs/rmdir', { path: childPath });
    } else {
      await this.#syscall('fs/unlink', { path: childPath });
    }
  }

  async #removeRecursive(path: string): Promise<void> {
    const entries = (await this.#syscall('fs/readdir', { path })) as DirEntryResult[];
    for (const e of entries) {
      const child = joinPath(path, e.name);
      if (e.type === 'directory') await this.#removeRecursive(child);
      else await this.#syscall('fs/unlink', { path: child });
    }
    await this.#syscall('fs/rmdir', { path });
  }

  /** Async iterator over child names. */
  async *keys(): AsyncIterableIterator<string> {
    for (const e of await this.#readEntries()) yield e.name;
  }

  /** Async iterator over child handles. */
  async *values(): AsyncIterableIterator<GuestFileHandle | GuestDirectoryHandle> {
    for (const e of await this.#readEntries()) yield this.#entryHandle(e);
  }

  /** Async iterator over `[name, handle]` pairs (the default iterator). */
  async *entries(): AsyncIterableIterator<[string, GuestFileHandle | GuestDirectoryHandle]> {
    for (const e of await this.#readEntries()) yield [e.name, this.#entryHandle(e)];
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[string, GuestFileHandle | GuestDirectoryHandle]> {
    return this.entries();
  }

  async #readEntries(): Promise<DirEntryResult[]> {
    return (await this.#syscall('fs/readdir', { path: this.#path })) as DirEntryResult[];
  }

  #entryHandle(e: DirEntryResult): GuestFileHandle | GuestDirectoryHandle {
    const childPath = joinPath(this.#path, e.name);
    return e.type === 'directory'
      ? new GuestDirectoryHandle(this.#syscall, childPath, e.name)
      : new GuestFileHandle(this.#syscall, childPath, e.name);
  }

  /** Stat a path, returning its kind or undefined if it does not exist. */
  async #statKind(path: string): Promise<'file' | 'directory' | undefined> {
    try {
      const stat = (await this.#syscall('fs/stat', { path })) as StatResult;
      return stat.type === 'directory' ? 'directory' : 'file';
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') return undefined;
      throw e;
    }
  }
}

/**
 * Open the VFS root as a `FileSystemDirectoryHandle`-shaped handle. The root's
 * `name` is `''` (matching the web FSA root). All paths are resolved absolutely
 * from `/`, so the returned handle is the entry point for the typed fs surface.
 */
export function openRoot(syscall: SyscallHook): GuestDirectoryHandle {
  return new GuestDirectoryHandle(syscall, '/', '');
}

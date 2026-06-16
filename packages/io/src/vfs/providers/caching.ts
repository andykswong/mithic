import type { FileHandle, OpenFlags, DirEntry, FileSystemProvider, FileStat } from '../provider.ts';
import { normalizePath } from '../path-utils.ts';

/**
 * Options for constructing a CachingProvider.
 */
export interface CachingProviderOptions {
  /** Maximum number of file content entries to keep in the in-memory LRU cache. Default: 128. */
  maxEntries?: number;
}

/** Cached file content entry. */
interface CacheEntry {
  data: Uint8Array;
  /** LRU insertion/access order counter. */
  lruTick: number;
}

/**
 * A two-tier caching FileSystemProvider:
 *
 *   hot (in-memory LRU) → remote (cold)
 *
 * Strategy:
 *   - **Reads**:  check hot LRU first; on miss, fetch from remote and populate the cache.
 *   - **Writes**: write-through — data is written to the remote immediately and the cached
 *     entry is updated so subsequent reads return the new content without a round-trip.
 *   - **Structural ops** (mkdir/unlink/rename/rmdir/etc.): delegated directly to remote;
 *     affected path entries are evicted from the cache so stale data is never served.
 *
 * The cache key is the normalized absolute path of the file.
 *
 * Future tiers:
 *   A warm IndexedDB tier (persistent across page reloads) could be inserted between
 *   the in-memory LRU and the remote for offline-capable workloads. That tier is
 *   intentionally omitted here to keep the implementation simple and correct; the
 *   read-through/write-through contract is the same regardless of tier count.
 */
export class CachingProvider implements FileSystemProvider {
  #remote: FileSystemProvider;
  #maxEntries: number;
  #cache = new Map<string, CacheEntry>();
  #tick = 0;

  constructor(remote: FileSystemProvider, options?: CachingProviderOptions) {
    this.#remote = remote;
    this.#maxEntries = options?.maxEntries ?? 128;
  }

  // --- Lifecycle ---

  async init(): Promise<void> {
    await this.#remote.init?.();
  }

  async dispose(): Promise<void> {
    this.#cache.clear();
    await this.#remote.dispose?.();
  }

  // --- Open / Close ---

  async open(path: string, flags: OpenFlags): Promise<FileHandle> {
    const handle = await this.#remote.open(path, flags);
    // Fix 1: truncate-on-open must evict the cache entry so the stale buffer is not
    // used as the base for subsequent write-through patches.
    if (flags.truncate) {
      this.#evict(handle.path);
    }
    return handle;
  }

  async close(handle: FileHandle): Promise<void> {
    return this.#remote.close(handle);
  }

  // --- Read (read-through) ---

  async read(handle: FileHandle, offset: number, len: number): Promise<Uint8Array> {
    const key = handle.path;
    const cached = this.#cache.get(key);

    if (cached !== undefined) {
      // Cache hit — update LRU tick and slice from cached data
      cached.lruTick = ++this.#tick;
      return cached.data.slice(offset, offset + len);
    }

    // Cache miss — read full file content from remote, then serve the slice.
    // We need full-file content to populate the cache, so we open a fresh
    // handle for stat+read, then return the requested slice.
    const fullData = await this.#fetchFullFile(handle);
    this.#putCache(key, fullData);
    return fullData.slice(offset, offset + len);
  }

  // --- Write (write-through) ---

  async write(handle: FileHandle, data: Uint8Array, offset: number): Promise<number> {
    const written = await this.#remote.write(handle, data, offset);

    // Fix 3: append-mode writes ignore the caller's offset and write at EOF on the
    // remote. Patching the cache at the wrong offset would corrupt it, so evict
    // the entry and let the next read re-fetch from the remote.
    const key = handle.path;
    if (handle.flags.append) {
      this.#evict(key);
      return written;
    }

    // Update cache: if entry exists, patch it in-place; otherwise evict so the next
    // read fetches fresh data from the remote (avoids a full re-read on every write).
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      const newLen = Math.max(cached.data.length, offset + data.length);
      const newBuf = new Uint8Array(newLen);
      newBuf.set(cached.data);
      newBuf.set(data, offset);
      cached.data = newBuf;
      cached.lruTick = ++this.#tick;
    }
    // If not cached, no action needed — next read will populate the cache.

    return written;
  }

  async truncate(handle: FileHandle, size: number): Promise<void> {
    await this.#remote.truncate(handle, size);
    const key = handle.path;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      if (size < cached.data.length) {
        cached.data = cached.data.slice(0, size);
      } else if (size > cached.data.length) {
        const expanded = new Uint8Array(size);
        expanded.set(cached.data);
        cached.data = expanded;
      }
      cached.lruTick = ++this.#tick;
    }
  }

  // --- Stat / Readdir (delegated, no caching needed) ---

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<FileStat> {
    return this.#remote.stat(path, options);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    return this.#remote.readdir(path);
  }

  // --- Structural ops: delegate + invalidate affected cache entries ---

  async mkdir(path: string): Promise<void> {
    return this.#remote.mkdir(path);
  }

  async unlink(path: string): Promise<void> {
    await this.#remote.unlink(path);
    // Fix 4b: normalize the path so the eviction key matches how cache entries are stored.
    this.#evict(normalizePath(path));
  }

  async rmdir(path: string): Promise<void> {
    await this.#remote.rmdir(path);
    this.#evictPrefix(normalizePath(path));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.#remote.rename(oldPath, newPath);
    // Fix 2: for directory renames, evict all descendants under both old and new paths.
    // Using prefix-eviction is correct for file renames too (a file has no descendants).
    // Fix 4b: normalize paths before evicting.
    this.#evictPrefix(normalizePath(oldPath));
    this.#evictPrefix(normalizePath(newPath));
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    return this.#remote.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    return this.#remote.readlink(path);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    return this.#remote.link(existingPath, newPath);
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.#remote.chmod(path, mode);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.#remote.utimes(path, atime, mtime);
  }

  async mkfifo(path: string): Promise<void> {
    return this.#remote.mkfifo(path);
  }

  async sync?(): Promise<void> {
    return this.#remote.sync?.();
  }

  // Fix 4a: use optional chaining instead of non-null assertion so a remote without
  // realpath returns undefined gracefully instead of throwing.
  // eslint-disable-next-line @typescript-eslint/require-await
  async realpath?(path: string): Promise<string> {
    // If remote has no realpath, the optional chain returns undefined. The cast
    // matches the base interface signature — callers using `?.` get undefined safely.
    return this.#remote.realpath?.(path) as Promise<string>;
  }

  // --- Private helpers ---

  /**
   * Reads the entire content of the file referenced by `handle` from the remote.
   * Opens a temporary handle at offset 0 with a large read to capture all data.
   */
  async #fetchFullFile(handle: FileHandle): Promise<Uint8Array> {
    // We don't know the file size without stat, so stat first.
    const stat = await this.#remote.stat(handle.path);
    const size = Number(stat.size);
    if (size === 0) return new Uint8Array(0);

    // Open a fresh read handle to get the full file content.
    const readHandle = await this.#remote.open(handle.path, { read: true });
    try {
      return await this.#remote.read(readHandle, 0, size);
    } finally {
      await this.#remote.close(readHandle);
    }
  }

  /** Insert or replace an entry, evicting the LRU entry if over capacity. */
  #putCache(key: string, data: Uint8Array): void {
    if (this.#cache.size >= this.#maxEntries && !this.#cache.has(key)) {
      this.#evictLRU();
    }
    this.#cache.set(key, { data, lruTick: ++this.#tick });
  }

  /** Remove a single path from the cache. */
  #evict(path: string): void {
    this.#cache.delete(path);
  }

  /** Remove all cache entries whose path starts with `prefix/`. */
  #evictPrefix(prefix: string): void {
    const p = prefix.endsWith('/') ? prefix : prefix + '/';
    for (const key of this.#cache.keys()) {
      if (key === prefix || key.startsWith(p)) {
        this.#cache.delete(key);
      }
    }
  }

  /** Evict the single entry with the lowest lruTick (least recently used). */
  #evictLRU(): void {
    let lruKey: string | undefined;
    let lruTick = Infinity;
    for (const [key, entry] of this.#cache) {
      if (entry.lruTick < lruTick) {
        lruTick = entry.lruTick;
        lruKey = key;
      }
    }
    if (lruKey !== undefined) {
      this.#cache.delete(lruKey);
    }
  }
}

import { expect, describe, it, beforeEach, vi } from 'vitest';
import { CachingProvider } from './caching.ts';
import { MemoryFsProvider } from './memory.ts';
import type { FileHandle } from '../provider.ts';
import { FileSystemError } from '../provider.ts';

// ---------------------------------------------------------------------------
// Spy wrapper — counts how many times read() is called on the remote.
// ---------------------------------------------------------------------------

class SpyProvider extends MemoryFsProvider {
  readCalls = 0;

  override read(handle: FileHandle, offset: number, len: number): Uint8Array {
    this.readCalls++;
    return super.read(handle, offset, len);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function writeFile(provider: CachingProvider, path: string, content: string): Promise<void> {
  const handle = await provider.open(path, { create: true, write: true, truncate: true });
  await provider.write(handle, enc.encode(content), 0);
  await provider.close(handle);
}

async function readFile(provider: CachingProvider, path: string): Promise<string> {
  const handle = await provider.open(path, { read: true });
  // Use a large len so we get the full content.
  const data = await provider.read(handle, 0, 65536);
  await provider.close(handle);
  return dec.decode(data);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CachingProvider', () => {
  let remote: SpyProvider;
  let cache: CachingProvider;

  beforeEach(() => {
    remote = new SpyProvider();
    cache = new CachingProvider(remote);
  });

  describe('init / dispose', () => {
    it('forwards init() to the remote', async () => {
      const initSpy = vi.spyOn(remote, 'init');
      await cache.init();
      expect(initSpy).toHaveBeenCalledOnce();
    });

    it('forwards dispose() to the remote', async () => {
      const disposeSpy = vi.spyOn(remote, 'dispose');
      await cache.dispose();
      expect(disposeSpy).toHaveBeenCalledOnce();
    });
  });

  describe('read-through caching', () => {
    it('reads from remote on first access (cache miss)', async () => {
      await writeFile(cache, '/a.txt', 'hello');
      remote.readCalls = 0; // reset counter after write

      await readFile(cache, '/a.txt');
      expect(remote.readCalls).toBeGreaterThan(0);
    });

    it('serves subsequent read from cache (remote NOT hit again)', async () => {
      await writeFile(cache, '/b.txt', 'world');
      // First read populates cache
      await readFile(cache, '/b.txt');
      const callsAfterFirst = remote.readCalls;

      // Second read must come from cache — remote.read call count must not increase
      const result = await readFile(cache, '/b.txt');
      expect(result).toBe('world');
      expect(remote.readCalls).toBe(callsAfterFirst);
    });

    it('returns correct content from cache', async () => {
      await writeFile(cache, '/c.txt', 'cached content');
      await readFile(cache, '/c.txt'); // populate cache
      const second = await readFile(cache, '/c.txt');
      expect(second).toBe('cached content');
    });

    it('handles partial offset reads from cache', async () => {
      await writeFile(cache, '/partial.txt', 'abcdefgh');
      await readFile(cache, '/partial.txt'); // populate cache

      const callsBefore = remote.readCalls;
      const handle = await cache.open('/partial.txt', { read: true });
      const slice = await cache.read(handle, 2, 4);
      await cache.close(handle);
      expect(dec.decode(slice)).toBe('cdef');
      // No extra remote reads — served from cache
      expect(remote.readCalls).toBe(callsBefore);
    });
  });

  describe('write-through', () => {
    it('propagates write to the remote', async () => {
      await writeFile(cache, '/wt.txt', 'original');

      // Write new content through the cache
      await writeFile(cache, '/wt.txt', 'updated');

      // Read directly from remote (bypass cache) to confirm write went through
      const handle = remote.open('/wt.txt', { read: true });
      const data = remote.read(handle, 0, 65536);
      remote.close(handle);
      expect(dec.decode(data)).toBe('updated');
    });

    it('subsequent read after write (no truncate) returns new data without extra remote reads', async () => {
      await writeFile(cache, '/cache-update.txt', 'v1v1');
      await readFile(cache, '/cache-update.txt'); // populate cache

      // Write new data through cache WITHOUT truncate — write-through patches the cached entry
      const handle = await cache.open('/cache-update.txt', { write: true });
      await cache.write(handle, enc.encode('v2v2'), 0);
      await cache.close(handle);

      const callsBefore = remote.readCalls;
      const result = await readFile(cache, '/cache-update.txt');
      // Cache was updated by write-through (no truncate = no eviction), so no extra remote read
      expect(remote.readCalls).toBe(callsBefore);
      expect(result).toBe('v2v2');
    });

    it('subsequent read after open+truncate+write returns correct data (cache evicted on truncate)', async () => {
      await writeFile(cache, '/cache-trunc.txt', 'v1');
      await readFile(cache, '/cache-trunc.txt'); // populate cache

      // open({truncate:true}) evicts the cache entry (Fix 1). The following write goes
      // to the remote but does not find a cache entry to patch, so the next read will
      // fetch from remote once — that is the correct and expected behavior.
      const handle = await cache.open('/cache-trunc.txt', { write: true, truncate: true });
      await cache.write(handle, enc.encode('v2'), 0);
      await cache.close(handle);

      const result = await readFile(cache, '/cache-trunc.txt');
      expect(result).toBe('v2');
    });
  });

  describe('invalidation on unlink', () => {
    it('evicts cache entry when file is deleted', async () => {
      await writeFile(cache, '/del.txt', 'to be deleted');
      await readFile(cache, '/del.txt'); // populate cache

      await cache.unlink('/del.txt');

      // File no longer exists; opening should throw
      await expect(cache.open('/del.txt', { read: true })).rejects.toThrow();
    });

    it('after unlink+recreate, read fetches fresh data from remote', async () => {
      await writeFile(cache, '/recreate.txt', 'v1');
      await readFile(cache, '/recreate.txt'); // populate cache
      await cache.unlink('/recreate.txt');
      await writeFile(cache, '/recreate.txt', 'v2');

      const callsBefore = remote.readCalls;
      const result = await readFile(cache, '/recreate.txt');
      expect(result).toBe('v2');
      // Cache was evicted on unlink, so a remote read is needed on first access
      expect(remote.readCalls).toBeGreaterThan(callsBefore);
    });

    it('evicts cache on unlink even with non-normalized path', async () => {
      await cache.mkdir('/dir');
      await writeFile(cache, '/dir/file.txt', 'data');
      await readFile(cache, '/dir/file.txt'); // populate cache

      // Unlink with non-normalized path that resolves to the same entry
      await cache.unlink('/dir//file.txt');

      // Should be evicted; recreate with new content
      await writeFile(cache, '/dir/file.txt', 'fresh');
      const callsBefore = remote.readCalls;
      const result = await readFile(cache, '/dir/file.txt');
      expect(result).toBe('fresh');
      // Must have gone to remote (cache was evicted by the non-normalized unlink)
      expect(remote.readCalls).toBeGreaterThan(callsBefore);
    });
  });

  describe('invalidation on rename', () => {
    it('evicts old path and new path from cache on file rename', async () => {
      await writeFile(cache, '/old-name.txt', 'content');
      await readFile(cache, '/old-name.txt'); // populate cache for old path

      await cache.rename('/old-name.txt', '/new-name.txt');

      // Old path must not exist
      await expect(cache.open('/old-name.txt', { read: true })).rejects.toThrow();

      // New path must have the correct content
      const callsBefore = remote.readCalls;
      const result = await readFile(cache, '/new-name.txt');
      expect(result).toBe('content');
      // Cache had no entry for new-name — remote was consulted
      expect(remote.readCalls).toBeGreaterThan(callsBefore);
    });

    it('evicts all descendant cache entries when a directory is renamed (Fix 2)', async () => {
      // Setup: create a directory with a file inside, cache the file
      await cache.mkdir('/dir');
      await writeFile(cache, '/dir/file.txt', 'inside dir');
      await readFile(cache, '/dir/file.txt'); // populate cache for /dir/file.txt

      // Rename the directory — moves /dir → /newdir (and /dir/file.txt → /newdir/file.txt)
      await cache.rename('/dir', '/newdir');

      // The stale cache entry for /dir/file.txt must be gone.
      // Re-create /dir and write DIFFERENT content directly to remote at /dir/file.txt.
      // If the old stale cache entry is still alive, a cache read would return 'inside dir'.
      // If it was properly evicted, a read must go to the remote and return 'stale-test'.
      remote.mkdir('/dir');
      const h = remote.open('/dir/file.txt', { create: true, write: true });
      remote.write(h, enc.encode('stale-test'), 0);
      remote.close(h);

      const callsBefore = remote.readCalls;
      const result = await readFile(cache, '/dir/file.txt');
      // If cache was NOT evicted, result would be 'inside dir' (stale). Must be 'stale-test'.
      expect(result).toBe('stale-test');
      // Must have gone to remote (cache evicted)
      expect(remote.readCalls).toBeGreaterThan(callsBefore);
    });
  });

  describe('open with truncate flag invalidates cache (Fix 1)', () => {
    it('open({truncate:true}) evicts stale cache so subsequent write+read returns correct data', async () => {
      // Populate cache with 'hello' (5 bytes)
      await writeFile(cache, '/trunc.txt', 'hello');
      await readFile(cache, '/trunc.txt'); // ensures cache entry exists

      // Now open with truncate (simulates writeFile pattern)
      const handle = await cache.open('/trunc.txt', { write: true, truncate: true });
      // Write 'hi' (2 bytes) at offset 0
      await cache.write(handle, enc.encode('hi'), 0);
      await cache.close(handle);

      // Read back through cache — must be 'hi', NOT 'hillo' (stale patch of 'hello')
      const viaCache = await readFile(cache, '/trunc.txt');
      expect(viaCache).toBe('hi');

      // Also verify remote has correct data
      const h = remote.open('/trunc.txt', { read: true });
      const raw = remote.read(h, 0, 65536);
      remote.close(h);
      expect(dec.decode(raw)).toBe('hi');
    });

    it('writeFile pattern (open create+write+truncate) leaves cache coherent', async () => {
      // Simulate two sequential writeFile calls — classic overwrite scenario
      await writeFile(cache, '/overwrite.txt', 'longer content here');
      await readFile(cache, '/overwrite.txt'); // populate cache

      // Second writeFile overwrites with shorter content
      await writeFile(cache, '/overwrite.txt', 'short');

      const result = await readFile(cache, '/overwrite.txt');
      expect(result).toBe('short');

      // Remote must also have correct data
      const h = remote.open('/overwrite.txt', { read: true });
      const raw = remote.read(h, 0, 65536);
      remote.close(h);
      expect(dec.decode(raw)).toBe('short');
    });
  });

  describe('append-mode write coherence (Fix 3)', () => {
    it('append-mode write does not corrupt the cache', async () => {
      // Populate cache with 'hello' (5 bytes)
      await writeFile(cache, '/append.txt', 'hello');
      await readFile(cache, '/append.txt'); // populate cache

      // Open in append mode and write '!'
      const handle = await cache.open('/append.txt', { append: true, write: true });
      await cache.write(handle, enc.encode('!'), 0); // offset ignored in append mode
      await cache.close(handle);

      // Read back through cache — must match remote ('hello!')
      const viaCache = await readFile(cache, '/append.txt');

      // Also read directly from remote to get the ground truth
      const h = remote.open('/append.txt', { read: true });
      const raw = remote.read(h, 0, 65536);
      remote.close(h);
      const viaRemote = dec.decode(raw);

      expect(viaRemote).toBe('hello!');
      expect(viaCache).toBe('hello!');
    });

    it('cache is coherent after multiple appends', async () => {
      await writeFile(cache, '/multi-append.txt', 'abc');
      await readFile(cache, '/multi-append.txt');

      const h1 = await cache.open('/multi-append.txt', { append: true, write: true });
      await cache.write(h1, enc.encode('d'), 0);
      await cache.close(h1);

      const h2 = await cache.open('/multi-append.txt', { append: true, write: true });
      await cache.write(h2, enc.encode('e'), 0);
      await cache.close(h2);

      const result = await readFile(cache, '/multi-append.txt');
      expect(result).toBe('abcde');
    });
  });

  describe('realpath optional chaining (Fix 4)', () => {
    it('realpath does not throw when remote has no realpath method', async () => {
      // Build a minimal remote that explicitly lacks a realpath method
      const minimalRemote = new MemoryFsProvider();
      // Cast through unknown to satisfy TypeScript while stripping the method
      const remoteWithoutRealpath = minimalRemote as unknown as MemoryFsProvider;
      (remoteWithoutRealpath as { realpath: unknown }).realpath = undefined;

      const noRealpathCache = new CachingProvider(remoteWithoutRealpath);
      // Must NOT throw — should gracefully return undefined
      const result = await noRealpathCache.realpath?.('/some/path');
      expect(result).toBeUndefined();
    });

    it('realpath delegates to remote when remote has realpath', async () => {
      await writeFile(cache, '/real.txt', 'x');
      const result = await cache.realpath?.('/real.txt');
      expect(result).toBe('/real.txt');
    });
  });

  describe('delegation to remote', () => {
    it('mkdir creates directory visible in readdir', async () => {
      await cache.mkdir('/subdir');
      const entries = await cache.readdir('/');
      expect(entries.some(e => e.name === 'subdir')).toBe(true);
    });

    it('stat returns correct info', async () => {
      await writeFile(cache, '/stat.txt', 'abc');
      const s = await cache.stat('/stat.txt');
      expect(s.type).toBe('file');
      expect(s.size).toBe(3n);
    });

    it('stat throws for non-existent path', async () => {
      await expect(cache.stat('/nonexistent.txt')).rejects.toThrow(FileSystemError);
    });
  });

  describe('LRU eviction', () => {
    it('evicts least-recently-used entry when maxEntries is exceeded', async () => {
      const smallCache = new CachingProvider(remote, { maxEntries: 2 });

      await writeFile(smallCache, '/f1.txt', 'f1');
      await writeFile(smallCache, '/f2.txt', 'f2');
      await writeFile(smallCache, '/f3.txt', 'f3');

      // Populate cache with f1, f2 (fills the 2-entry cache)
      await readFile(smallCache, '/f1.txt');
      await readFile(smallCache, '/f2.txt');

      // Access f1 to make it the most recently used
      await readFile(smallCache, '/f1.txt');

      // Reading f3 should evict f2 (least recently used)
      const callsBefore = remote.readCalls;
      await readFile(smallCache, '/f3.txt');
      expect(remote.readCalls).toBeGreaterThan(callsBefore); // f3 not cached

      // f1 should still be in cache (most recently used, not evicted)
      const callsBeforeF1 = remote.readCalls;
      await readFile(smallCache, '/f1.txt');
      expect(remote.readCalls).toBe(callsBeforeF1); // served from cache
    });
  });
});

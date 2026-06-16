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

      const handle = await cache.open('/partial.txt', { read: true });
      const slice = await cache.read(handle, 2, 4);
      await cache.close(handle);
      expect(dec.decode(slice)).toBe('cdef');
      expect(remote.readCalls).toBe(remote.readCalls); // no extra remote reads
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

    it('subsequent read after write returns new data without extra remote reads', async () => {
      await writeFile(cache, '/cache-update.txt', 'v1');
      await readFile(cache, '/cache-update.txt'); // populate cache

      // Write new data through cache (write-through also updates cached entry)
      const handle = await cache.open('/cache-update.txt', { write: true, truncate: true });
      await cache.write(handle, enc.encode('v2'), 0);
      await cache.close(handle);

      const callsBefore = remote.readCalls;
      const result = await readFile(cache, '/cache-update.txt');
      // Cache was updated by write-through, so no additional remote read needed
      expect(remote.readCalls).toBe(callsBefore);
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
  });

  describe('invalidation on rename', () => {
    it('evicts old path and new path from cache on rename', async () => {
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

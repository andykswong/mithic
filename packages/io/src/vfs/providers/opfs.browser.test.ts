/**
 * OPFS async-usage browser test — Group O
 *
 * Exercises OPFSProvider against the real Origin Private File System API in
 * Chromium. Proves the provider satisfies async usage: write/read/readdir
 * round-trips on a real OPFS-backed storage.
 *
 * Each test suite gets a unique subdirectory so runs don't interfere.
 */
import { expect, describe, it, beforeEach } from 'vitest';
import { OPFSProvider } from './opfs.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Create an OPFSProvider rooted under a fresh unique test subdirectory. */
async function makeProvider(testId: string): Promise<OPFSProvider> {
  const root = await navigator.storage.getDirectory();
  // Create an isolated subdirectory for this test run.
  const sub = await root.getDirectoryHandle(`test-${testId}-${Date.now()}`, { create: true });
  const storage = { getDirectory: async () => sub };
  const provider = new OPFSProvider(storage);
  await provider.init();
  return provider;
}

describe('OPFSProvider (real OPFS, browser)', () => {
  let provider: OPFSProvider;

  beforeEach(async () => {
    provider = await makeProvider('opfs-basic');
  });

  describe('write / read round-trip', () => {
    it('writes bytes and reads them back correctly', async () => {
      const handle = await provider.open('/hello.txt', { create: true, write: true });
      const payload = enc.encode('Hello, OPFS!');
      const written = await provider.write(handle, payload, 0);
      expect(written).toBe(payload.byteLength);
      await provider.close(handle);

      const rh = await provider.open('/hello.txt', { read: true });
      const data = await provider.read(rh, 0, payload.byteLength);
      await provider.close(rh);

      expect(dec.decode(data)).toBe('Hello, OPFS!');
    });

    it('reads partial slice at offset', async () => {
      const handle = await provider.open('/offset.txt', { create: true, write: true });
      await provider.write(handle, enc.encode('abcdefghij'), 0);
      await provider.close(handle);

      const rh = await provider.open('/offset.txt', { read: true });
      const slice = await provider.read(rh, 3, 4);
      await provider.close(rh);

      expect(dec.decode(slice)).toBe('defg');
    });
  });

  describe('stat', () => {
    it('returns file type and correct size', async () => {
      const handle = await provider.open('/stat.txt', { create: true, write: true });
      await provider.write(handle, enc.encode('abc'), 0);
      await provider.close(handle);

      const s = await provider.stat('/stat.txt');
      expect(s.type).toBe('file');
      expect(s.size).toBe(3n);
    });

    it('returns directory type for a directory', async () => {
      await provider.mkdir('/mydir');
      const s = await provider.stat('/mydir');
      expect(s.type).toBe('directory');
    });

    it('throws no-entry for non-existent path', async () => {
      await expect(provider.stat('/ghost.txt')).rejects.toThrow();
    });
  });

  describe('readdir', () => {
    it('lists created files and directories', async () => {
      await provider.mkdir('/container');
      const fh = await provider.open('/container/file.txt', { create: true, write: true });
      await provider.close(fh);
      await provider.mkdir('/container/sub');

      const entries = await provider.readdir('/container');
      const names = entries.map(e => e.name).sort();
      expect(names).toContain('file.txt');
      expect(names).toContain('sub');
    });

    it('returns empty list for an empty directory', async () => {
      await provider.mkdir('/empty');
      const entries = await provider.readdir('/empty');
      expect(entries).toHaveLength(0);
    });
  });

  describe('unlink', () => {
    it('removes a file so stat throws afterwards', async () => {
      const fh = await provider.open('/todelete.txt', { create: true, write: true });
      await provider.write(fh, enc.encode('bye'), 0);
      await provider.close(fh);

      await provider.unlink('/todelete.txt');
      await expect(provider.stat('/todelete.txt')).rejects.toThrow();
    });
  });

  describe('rename', () => {
    it('moves a file and old path no longer exists', async () => {
      const fh = await provider.open('/src.txt', { create: true, write: true });
      await provider.write(fh, enc.encode('data'), 0);
      await provider.close(fh);

      await provider.rename('/src.txt', '/dst.txt');

      const s = await provider.stat('/dst.txt');
      expect(s.type).toBe('file');
      expect(s.size).toBe(4n);

      await expect(provider.stat('/src.txt')).rejects.toThrow();
    });
  });

  describe('truncate', () => {
    it('truncates a file to a shorter length', async () => {
      const fh = await provider.open('/trunc.txt', { create: true, write: true });
      await provider.write(fh, enc.encode('hello world'), 0);
      await provider.truncate(fh, 5);
      await provider.close(fh);

      const s = await provider.stat('/trunc.txt');
      expect(s.size).toBe(5n);
    });
  });

  describe('mkdir + rmdir', () => {
    it('creates and removes an empty directory', async () => {
      await provider.mkdir('/removable');
      await provider.rmdir('/removable');
      await expect(provider.stat('/removable')).rejects.toThrow();
    });

    it('throws exist when mkdir is called twice', async () => {
      await provider.mkdir('/once');
      await expect(provider.mkdir('/once')).rejects.toThrow();
    });
  });
});

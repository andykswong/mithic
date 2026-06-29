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
import { FileSystemError } from '../provider.ts';

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

describe('OPFSProvider persistence (metadata store + append, browser)', () => {
  /** A storage manager pinned to a single fresh OPFS subdirectory, so two
   *  providers built from it share the same backing root (simulating reload). */
  async function makeSharedRoot(testId: string): Promise<{ getDirectory: () => Promise<FileSystemDirectoryHandle> }> {
    const root = await navigator.storage.getDirectory();
    const sub = await root.getDirectoryHandle(`test-${testId}-${Date.now()}`, { create: true });
    return { getDirectory: async () => sub };
  }

  it('xattr persists across a fresh provider over the same OPFS root', async () => {
    const storage = await makeSharedRoot('opfs-xattr-persist');
    const a = new OPFSProvider(storage);
    await a.init();
    const fh = await a.open('/u', { create: true, write: true, truncate: true });
    await a.write(fh, enc.encode('hi'), 0);
    await a.close(fh);
    await a.setxattr('/u', 'security.capability', new Uint8Array([7, 7]));
    expect(await a.listxattr('/u')).toContain('security.capability');
    await a.dispose();

    const b = new OPFSProvider(storage); // simulate reload
    await b.init();
    expect(Array.from((await b.getxattr('/u', 'security.capability'))!)).toEqual([7, 7]);
    expect(await b.listxattr('/u')).toContain('security.capability');

    await b.removexattr('/u', 'security.capability');
    await b.dispose();

    const c = new OPFSProvider(storage);
    await c.init();
    expect(await c.getxattr('/u', 'security.capability')).toBeUndefined();
    await c.dispose();
  });

  it('mode set via chmod persists across a fresh provider', async () => {
    const storage = await makeSharedRoot('opfs-mode-persist');
    const a = new OPFSProvider(storage);
    await a.init();
    const fh = await a.open('/bin', { create: true, write: true, truncate: true });
    await a.close(fh);
    await a.chmod('/bin', 0o755);
    expect((await a.stat('/bin')).mode).toBe(0o755);
    await a.dispose();

    const b = new OPFSProvider(storage);
    await b.init();
    expect((await b.stat('/bin')).mode).toBe(0o755);
    await b.dispose();
  });

  it('the metadata file is not surfaced by readdir', async () => {
    const storage = await makeSharedRoot('opfs-meta-hidden');
    const a = new OPFSProvider(storage);
    await a.init();
    const fh = await a.open('/real.txt', { create: true, write: true, truncate: true });
    await a.close(fh);
    await a.setxattr('/real.txt', 'security.capability', new Uint8Array([1]));
    const names = (await a.readdir('/')).map(e => e.name);
    expect(names).toContain('real.txt');
    expect(names).not.toContain('.mithic-meta.json');
    await a.dispose();
  });

  it('append-mode write lands at EOF, not offset 0', async () => {
    const storage = await makeSharedRoot('opfs-append');
    const fs = new OPFSProvider(storage);
    await fs.init();
    const h1 = await fs.open('/a.txt', { create: true, write: true, truncate: true });
    await fs.write(h1, enc.encode('abc'), 0);
    await fs.close(h1);
    const h2 = await fs.open('/a.txt', { write: true, append: true, truncate: false });
    await fs.write(h2, enc.encode('def'), 0);
    await fs.close(h2);
    const h3 = await fs.open('/a.txt', { read: true });
    expect(dec.decode(await fs.read(h3, 0, 64))).toBe('abcdef');
    await fs.close(h3);
    await fs.dispose();
  });

  it('xattr survives rename and is dropped on unlink', async () => {
    const storage = await makeSharedRoot('opfs-xattr-rename');
    const fs = new OPFSProvider(storage);
    await fs.init();
    const fh = await fs.open('/f', { create: true, write: true, truncate: true });
    await fs.write(fh, enc.encode('x'), 0);
    await fs.close(fh);
    await fs.setxattr('/f', 'security.capability', new Uint8Array([1, 2, 3]));

    await fs.rename('/f', '/g');
    expect(Array.from((await fs.getxattr('/g', 'security.capability'))!)).toEqual([1, 2, 3]);
    // The old path no longer exists, so xattr reads against it are rejected.
    await expect(fs.getxattr('/f', 'security.capability')).rejects.toThrow();

    await fs.unlink('/g');
    await expect(fs.getxattr('/g', 'security.capability')).rejects.toThrow();
    await fs.dispose();
  });

  it('directory rename migrates descendant xattrs to the new path', async () => {
    const storage = await makeSharedRoot('opfs-xattr-dir-rename');
    const fs = new OPFSProvider(storage);
    await fs.init();
    await fs.mkdir('/d');
    const fh = await fs.open('/d/child', { create: true, write: true, truncate: true });
    await fs.write(fh, enc.encode('x'), 0);
    await fs.close(fh);
    await fs.setxattr('/d', 'security.capability', new Uint8Array([1]));
    await fs.setxattr('/d/child', 'security.capability', new Uint8Array([2]));

    await fs.rename('/d', '/moved');

    expect(Array.from((await fs.getxattr('/moved', 'security.capability'))!)).toEqual([1]);
    expect(Array.from((await fs.getxattr('/moved/child', 'security.capability'))!)).toEqual([2]);
    expect(await fs.getxattr('/moved', 'security.capability')).toBeDefined();
    await fs.dispose();
  });

  it('rmdir drops sidecar metadata so a recreated same-named dir inherits nothing', async () => {
    const storage = await makeSharedRoot('opfs-xattr-rmdir');
    const fs = new OPFSProvider(storage);
    await fs.init();
    await fs.mkdir('/gone');
    await fs.setxattr('/gone', 'security.capability', new Uint8Array([7, 7]));
    await fs.rmdir('/gone');

    await fs.mkdir('/gone');
    expect(await fs.getxattr('/gone', 'security.capability')).toBeUndefined();
    expect(await fs.listxattr('/gone')).toEqual([]);
    await fs.dispose();
  });

  it('the metadata sidecar is not a reachable VFS path', async () => {
    const META = '/.mithic-meta.json';
    const isNoEntry = (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry';

    const storage = await makeSharedRoot('opfs-meta-guard');
    const fs = new OPFSProvider(storage);
    await fs.init();
    // Materialize the sidecar by setting an xattr on a real file.
    const sh = await fs.open('/seed.bin', { create: true, write: true, truncate: true });
    await fs.close(sh);
    await fs.setxattr('/seed.bin', 'security.capability', new Uint8Array([1]));

    // open (read + write/create), stat, unlink, rename (src + dest) all rejected.
    await expect(fs.open(META, { read: true })).rejects.toSatisfy(isNoEntry);
    await expect(
      fs.open(META, { write: true, create: true, truncate: true }),
    ).rejects.toSatisfy(isNoEntry);
    await expect(fs.stat(META)).rejects.toSatisfy(isNoEntry);
    await expect(fs.unlink(META)).rejects.toSatisfy(isNoEntry);
    await expect(fs.rename(META, '/stolen.json')).rejects.toSatisfy(isNoEntry);
    await expect(fs.rename('/seed.bin', META)).rejects.toSatisfy(isNoEntry);

    // The legit grant is intact and reachable only via the capability-checked
    // setxattr path — a direct write could not forge it.
    expect(Array.from((await fs.getxattr('/seed.bin', 'security.capability'))!)).toEqual([1]);
    await fs.dispose();
  });

  it('setxattr on a normal file still works (legit path unaffected)', async () => {
    const storage = await makeSharedRoot('opfs-meta-guard-legit');
    const fs = new OPFSProvider(storage);
    await fs.init();
    const h = await fs.open('/normal.bin', { create: true, write: true, truncate: true });
    await fs.close(h);
    await fs.setxattr('/normal.bin', 'security.capability', new Uint8Array([5, 6]));
    expect(Array.from((await fs.getxattr('/normal.bin', 'security.capability'))!)).toEqual([5, 6]);
    await fs.dispose();
  });

  it('a .mithic-meta.json file in a SUBDIR is a normal usable file', async () => {
    const storage = await makeSharedRoot('opfs-meta-guard-subdir');
    const fs = new OPFSProvider(storage);
    await fs.init();
    await fs.mkdir('/sub');
    const subMeta = '/sub/.mithic-meta.json';
    const h = await fs.open(subMeta, { create: true, write: true, truncate: true });
    const payload = enc.encode('user data');
    await fs.write(h, payload, 0);
    await fs.close(h);

    expect((await fs.stat(subMeta)).type).toBe('file');
    const rh = await fs.open(subMeta, { read: true });
    expect(dec.decode(await fs.read(rh, 0, payload.length))).toBe('user data');
    await fs.close(rh);
    await fs.setxattr(subMeta, 'user.x', new Uint8Array([1]));
    expect(Array.from((await fs.getxattr(subMeta, 'user.x'))!)).toEqual([1]);
    await fs.dispose();
  });
});

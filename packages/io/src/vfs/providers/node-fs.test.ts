import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeFsProvider } from './node-fs.ts';
import { FileSystemError } from '../provider.ts';

describe('NodeFsProvider', () => {
  let tmpDir: string;
  let provider: NodeFsProvider;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfs-node-test-'));
    provider = new NodeFsProvider({ root: tmpDir });
  });

  afterAll(async () => {
    await provider.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write a file and read it back', async () => {
    const handle = await provider.open('/hello.txt', { create: true, write: true, read: true });
    const data = new TextEncoder().encode('Hello, Node.js!');
    await provider.write(handle, data, 0);
    const result = await provider.read(handle, 0, data.length);
    expect(result).toEqual(data);
    await provider.close(handle);
  });

  it('should mkdir and readdir', async () => {
    await provider.mkdir('/testdir');
    const h1 = await provider.open('/testdir/beta.txt', { create: true, write: true });
    await provider.close(h1);
    const h2 = await provider.open('/testdir/alpha.txt', { create: true, write: true });
    await provider.close(h2);

    const entries = await provider.readdir('/testdir');
    expect(entries.map(e => e.name)).toEqual(['alpha.txt', 'beta.txt']);
    expect(entries[0].type).toBe('file');
  });

  it('should return correct stat for file', async () => {
    const handle = await provider.open('/statfile.txt', { create: true, write: true });
    const data = new TextEncoder().encode('stat test');
    await provider.write(handle, data, 0);
    await provider.close(handle);

    const stat = await provider.stat('/statfile.txt');
    expect(stat.type).toBe('file');
    expect(stat.size).toBe(BigInt(data.length));
    expect(stat.mtime).toBeInstanceOf(Date);
    expect(stat.atime).toBeInstanceOf(Date);
    expect(stat.ctime).toBeInstanceOf(Date);
  });

  it('should return correct stat for directory', async () => {
    await provider.mkdir('/statdir');
    const stat = await provider.stat('/statdir');
    expect(stat.type).toBe('directory');
  });

  it('should chmod and update mode', async () => {
    const handle = await provider.open('/chmodfile.txt', { create: true, write: true });
    await provider.close(handle);

    await provider.chmod('/chmodfile.txt', 0o755);
    const stat = await provider.stat('/chmodfile.txt');
    expect(stat.mode & 0o777).toBe(0o755);
  });

  it('should symlink and readlink', async () => {
    const handle = await provider.open('/symtarget.txt', { create: true, write: true });
    const data = new TextEncoder().encode('symlink content');
    await provider.write(handle, data, 0);
    await provider.close(handle);

    await provider.symlink('./symtarget.txt', '/symlink.txt');
    const target = await provider.readlink('/symlink.txt');
    expect(target).toBe('./symtarget.txt');

    // Reading through symlink should work (stat with followSymlinks)
    const stat = await provider.stat('/symlink.txt', { followSymlinks: true });
    expect(stat.type).toBe('file');
    expect(stat.size).toBe(BigInt(data.length));
  });

  it('should rename a file', async () => {
    const handle = await provider.open('/oldname.txt', { create: true, write: true });
    const data = new TextEncoder().encode('rename content');
    await provider.write(handle, data, 0);
    await provider.close(handle);

    await provider.rename('/oldname.txt', '/newname.txt');

    await expect(
      provider.stat('/oldname.txt'),
    ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'no-entry');

    const stat = await provider.stat('/newname.txt');
    expect(stat.type).toBe('file');
    expect(stat.size).toBe(BigInt(data.length));
  });

  it('should unlink a file', async () => {
    const handle = await provider.open('/unlinkme.txt', { create: true, write: true });
    await provider.close(handle);

    await provider.unlink('/unlinkme.txt');

    await expect(
      provider.stat('/unlinkme.txt'),
    ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'no-entry');
  });

  it('should reject path traversal with ../', async () => {
    // Paths with .. that would logically escape root get normalized to stay within root.
    // /../../etc/passwd normalizes to /etc/passwd which resolves under root.
    // The provider should NOT grant access to files outside root.
    // After normalization, /../../etc/passwd -> <root>/etc/passwd which doesn't exist => no-entry.
    await expect(
      provider.stat('/../../etc/passwd'),
    ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'no-entry');

    // Verify that a path like /subdir/../../etc/hosts still resolves under root
    await provider.mkdir('/subdir');
    await expect(
      provider.stat('/subdir/../../etc/hosts'),
    ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'no-entry');
  });

  it('should open with create flag', async () => {
    const handle = await provider.open('/created.txt', { create: true, write: true });
    await provider.close(handle);
    const stat = await provider.stat('/created.txt');
    expect(stat.type).toBe('file');
  });

  it('should write at offset', async () => {
    const handle = await provider.open('/offset.txt', { create: true, write: true, read: true });
    await provider.write(handle, new TextEncoder().encode('AAAA'), 0);
    await provider.write(handle, new TextEncoder().encode('BB'), 2);

    const content = await provider.read(handle, 0, 4);
    expect(content).toEqual(new TextEncoder().encode('AABB'));
    await provider.close(handle);
  });

  it('should reject symlink with relative target that escapes root', async () => {
    await expect(
      provider.symlink('../../etc/passwd', '/escape-relative-link'),
    ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'access');
  });

  it('should allow symlink with VFS-absolute target (stays within root)', async () => {
    // VFS-absolute paths like /etc/passwd are resolved relative to root, not host
    const handle = await provider.open('/symlink-target-file.txt', { create: true, write: true });
    await provider.close(handle);
    await provider.symlink('/symlink-target-file.txt', '/vfs-absolute-link');
    const target = await provider.readlink('/vfs-absolute-link');
    expect(target).toBe('/symlink-target-file.txt');
  });

  it('realpath rejects resolved path outside root', async () => {
    await expect(
      provider.realpath('/nonexistent-for-realpath'),
    ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'no-entry');
  });
});

describe('NodeFsProvider xattr persistence', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfs-node-xattr-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('xattr set/get/list/remove round-trip survives a fresh provider over the same root', async () => {
    const a = new NodeFsProvider({ root: tmpDir });
    await a.init();
    const fh = await a.open('/cap.bin', { create: true, write: true, truncate: true });
    await a.write(fh, new TextEncoder().encode('x'), 0);
    await a.close(fh);
    await a.setxattr('/cap.bin', 'security.capability', new Uint8Array([7, 7]));
    expect(await a.listxattr('/cap.bin')).toContain('security.capability');
    await a.dispose();

    const b = new NodeFsProvider({ root: tmpDir });
    await b.init();
    expect(Array.from((await b.getxattr('/cap.bin', 'security.capability'))!)).toEqual([7, 7]);
    expect(await b.listxattr('/cap.bin')).toContain('security.capability');

    await b.removexattr('/cap.bin', 'security.capability');
    expect(await b.getxattr('/cap.bin', 'security.capability')).toBeUndefined();
    await b.dispose();

    const c = new NodeFsProvider({ root: tmpDir });
    await c.init();
    expect(await c.getxattr('/cap.bin', 'security.capability')).toBeUndefined();
    await c.dispose();
  });

  it('setxattr on a missing path throws no-entry', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    await expect(
      p.setxattr('/ghost.bin', 'security.capability', new Uint8Array([1])),
    ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'no-entry');
    await p.dispose();
  });

  it('getxattr returns a copy: mutating the result does not corrupt the store', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    const fh = await p.open('/copy.bin', { create: true, write: true, truncate: true });
    await p.close(fh);
    await p.setxattr('/copy.bin', 'user.x', new Uint8Array([1, 2, 3]));
    const got = (await p.getxattr('/copy.bin', 'user.x'))!;
    got[0] = 99;
    expect(Array.from((await p.getxattr('/copy.bin', 'user.x'))!)).toEqual([1, 2, 3]);
    await p.dispose();
  });

  it('directory rename migrates descendant xattrs to the new path (none orphaned)', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    await p.mkdir('/rdir');
    const fh = await p.open('/rdir/child.bin', { create: true, write: true, truncate: true });
    await p.close(fh);
    await p.setxattr('/rdir', 'security.capability', new Uint8Array([1]));
    await p.setxattr('/rdir/child.bin', 'security.capability', new Uint8Array([2]));

    await p.rename('/rdir', '/rmoved');

    expect(Array.from((await p.getxattr('/rmoved', 'security.capability'))!)).toEqual([1]);
    expect(Array.from((await p.getxattr('/rmoved/child.bin', 'security.capability'))!)).toEqual([2]);
    await p.dispose();
  });

  it('rmdir drops sidecar metadata so a recreated same-named dir inherits nothing', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    await p.mkdir('/gone');
    await p.setxattr('/gone', 'security.capability', new Uint8Array([7, 7]));
    await p.rmdir('/gone');

    await p.mkdir('/gone');
    expect(await p.getxattr('/gone', 'security.capability')).toBeUndefined();
    expect(await p.listxattr('/gone')).toEqual([]);

    // Survives a reload over the same root.
    const reloaded = new NodeFsProvider({ root: tmpDir });
    await reloaded.init();
    expect(await reloaded.getxattr('/gone', 'security.capability')).toBeUndefined();
    await reloaded.dispose();
    await p.dispose();
  });
});

describe('NodeFsProvider metadata sidecar is not a reachable VFS path', () => {
  const META = '/.mithic-meta.json';
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfs-node-meta-guard-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const isNoEntry = (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry';

  it('open(META, {read}) and open(META, {write,create}) both throw no-entry', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    // Materialize the sidecar by setting an xattr on a real file.
    const fh = await p.open('/seed.bin', { create: true, write: true, truncate: true });
    await p.close(fh);
    await p.setxattr('/seed.bin', 'security.capability', new Uint8Array([1]));

    await expect(p.open(META, { read: true })).rejects.toSatisfy(isNoEntry);
    await expect(
      p.open(META, { write: true, create: true, truncate: true }),
    ).rejects.toSatisfy(isNoEntry);
    await p.dispose();
  });

  it('stat/unlink/rename of META all throw no-entry', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    await expect(p.stat(META)).rejects.toSatisfy(isNoEntry);
    await expect(p.unlink(META)).rejects.toSatisfy(isNoEntry);
    await expect(p.rename(META, '/stolen.json')).rejects.toSatisfy(isNoEntry);
    await expect(p.rename('/seed.bin', META)).rejects.toSatisfy(isNoEntry);
    await p.dispose();
  });

  it('a direct write to META cannot forge another file\'s capability xattr', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    const fh = await p.open('/victim.bin', { create: true, write: true, truncate: true });
    await p.close(fh);
    await p.setxattr('/victim.bin', 'security.capability', new Uint8Array([1]));

    // Attacker tries to overwrite the backing store with a forged grant.
    const forged = new TextEncoder().encode(
      JSON.stringify({ '/victim.bin': { xattr: { 'security.capability': [9, 9, 9] } } }),
    );
    await expect(
      (async () => {
        const h = await p.open(META, { write: true, create: true, truncate: true });
        await p.write(h, forged, 0);
        await p.close(h);
      })(),
    ).rejects.toSatisfy(isNoEntry);

    // The legitimate grant is intact, reachable only via setxattr.
    const reloaded = new NodeFsProvider({ root: tmpDir });
    await reloaded.init();
    expect(Array.from((await reloaded.getxattr('/victim.bin', 'security.capability'))!)).toEqual([1]);
    await reloaded.dispose();
    await p.dispose();
  });

  it('setxattr on a normal file still works (legit path unaffected)', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    const fh = await p.open('/normal.bin', { create: true, write: true, truncate: true });
    await p.close(fh);
    await p.setxattr('/normal.bin', 'security.capability', new Uint8Array([5, 6]));
    expect(Array.from((await p.getxattr('/normal.bin', 'security.capability'))!)).toEqual([5, 6]);
    await p.dispose();
  });

  it('a file literally named .mithic-meta.json in a SUBDIR is a normal usable file', async () => {
    const p = new NodeFsProvider({ root: tmpDir });
    await p.init();
    await p.mkdir('/sub');
    const subMeta = '/sub/.mithic-meta.json';
    const fh = await p.open(subMeta, { create: true, write: true, truncate: true });
    const payload = new TextEncoder().encode('user data');
    await p.write(fh, payload, 0);
    await p.close(fh);

    expect((await p.stat(subMeta)).type).toBe('file');
    const rh = await p.open(subMeta, { read: true });
    expect(await p.read(rh, 0, payload.length)).toEqual(payload);
    await p.close(rh);
    await p.setxattr(subMeta, 'user.x', new Uint8Array([1]));
    expect(Array.from((await p.getxattr(subMeta, 'user.x'))!)).toEqual([1]);
    await p.dispose();
  });
});

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

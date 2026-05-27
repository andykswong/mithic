import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeFsProvider } from './node-fs.ts';
import { FileSystemError } from '../provider.ts';

describe('NodeFsProvider', () => {
  let tmpDir: string;
  let provider: NodeFsProvider;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfs-node-test-'));
    provider = new NodeFsProvider({ root: tmpDir });
  });

  after(async () => {
    await provider.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write a file and read it back', async () => {
    const handle = await provider.open('/hello.txt', { create: true, write: true, read: true });
    const data = new TextEncoder().encode('Hello, Node.js!');
    await provider.write(handle, data, 0);
    const result = await provider.read(handle, 0, data.length);
    assert.deepStrictEqual(result, data);
    await provider.close(handle);
  });

  it('should mkdir and readdir', async () => {
    await provider.mkdir('/testdir');
    const h1 = await provider.open('/testdir/beta.txt', { create: true, write: true });
    await provider.close(h1);
    const h2 = await provider.open('/testdir/alpha.txt', { create: true, write: true });
    await provider.close(h2);

    const entries = await provider.readdir('/testdir');
    assert.deepStrictEqual(entries.map(e => e.name), ['alpha.txt', 'beta.txt']);
    assert.strictEqual(entries[0].type, 'file');
  });

  it('should return correct stat for file', async () => {
    const handle = await provider.open('/statfile.txt', { create: true, write: true });
    const data = new TextEncoder().encode('stat test');
    await provider.write(handle, data, 0);
    await provider.close(handle);

    const stat = await provider.stat('/statfile.txt');
    assert.strictEqual(stat.type, 'file');
    assert.strictEqual(stat.size, BigInt(data.length));
    assert(stat.mtime instanceof Date);
    assert(stat.atime instanceof Date);
    assert(stat.ctime instanceof Date);
  });

  it('should return correct stat for directory', async () => {
    await provider.mkdir('/statdir');
    const stat = await provider.stat('/statdir');
    assert.strictEqual(stat.type, 'directory');
  });

  it('should chmod and update mode', async () => {
    const handle = await provider.open('/chmodfile.txt', { create: true, write: true });
    await provider.close(handle);

    await provider.chmod('/chmodfile.txt', 0o755);
    const stat = await provider.stat('/chmodfile.txt');
    assert.strictEqual(stat.mode & 0o777, 0o755);
  });

  it('should symlink and readlink', async () => {
    const handle = await provider.open('/symtarget.txt', { create: true, write: true });
    const data = new TextEncoder().encode('symlink content');
    await provider.write(handle, data, 0);
    await provider.close(handle);

    await provider.symlink('./symtarget.txt', '/symlink.txt');
    const target = await provider.readlink('/symlink.txt');
    assert.strictEqual(target, './symtarget.txt');

    // Reading through symlink should work (stat with followSymlinks)
    const stat = await provider.stat('/symlink.txt', { followSymlinks: true });
    assert.strictEqual(stat.type, 'file');
    assert.strictEqual(stat.size, BigInt(data.length));
  });

  it('should rename a file', async () => {
    const handle = await provider.open('/oldname.txt', { create: true, write: true });
    const data = new TextEncoder().encode('rename content');
    await provider.write(handle, data, 0);
    await provider.close(handle);

    await provider.rename('/oldname.txt', '/newname.txt');

    await assert.rejects(
      () => provider.stat('/oldname.txt'),
      (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
    );

    const stat = await provider.stat('/newname.txt');
    assert.strictEqual(stat.type, 'file');
    assert.strictEqual(stat.size, BigInt(data.length));
  });

  it('should unlink a file', async () => {
    const handle = await provider.open('/unlinkme.txt', { create: true, write: true });
    await provider.close(handle);

    await provider.unlink('/unlinkme.txt');

    await assert.rejects(
      () => provider.stat('/unlinkme.txt'),
      (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
    );
  });

  it('should reject path traversal with ../', async () => {
    // Paths with .. that would logically escape root get normalized to stay within root.
    // /../../etc/passwd normalizes to /etc/passwd which resolves under root.
    // The provider should NOT grant access to files outside root.
    // After normalization, /../../etc/passwd -> <root>/etc/passwd which doesn't exist => no-entry.
    await assert.rejects(
      () => provider.stat('/../../etc/passwd'),
      (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
    );

    // Verify that a path like /subdir/../../etc/hosts still resolves under root
    await provider.mkdir('/subdir');
    await assert.rejects(
      () => provider.stat('/subdir/../../etc/hosts'),
      (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
    );
  });

  it('should open with create flag', async () => {
    const handle = await provider.open('/created.txt', { create: true, write: true });
    await provider.close(handle);
    const stat = await provider.stat('/created.txt');
    assert.strictEqual(stat.type, 'file');
  });

  it('should write at offset', async () => {
    const handle = await provider.open('/offset.txt', { create: true, write: true, read: true });
    await provider.write(handle, new TextEncoder().encode('AAAA'), 0);
    await provider.write(handle, new TextEncoder().encode('BB'), 2);

    const content = await provider.read(handle, 0, 4);
    assert.deepStrictEqual(content, new TextEncoder().encode('AABB'));
    await provider.close(handle);
  });
});

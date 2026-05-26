import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { VirtualFileSystem } from './adapter.ts';

describe('VirtualFileSystem', () => {
  let router: FileSystemRouter;
  let adapter: VirtualFileSystem;

  beforeEach(async () => {
    router = new FileSystemRouter();
    const provider = new MemoryFsProvider();
    await router.mount('/', provider);
    adapter = new VirtualFileSystem(router, '/');
  });

  it('readFile and writeFile round-trip', async () => {
    await adapter.writeFile('/hello.txt', 'Hello, world!');
    const content = await adapter.readFile('/hello.txt');
    assert.equal(content, 'Hello, world!');
  });

  it('writeFile with Uint8Array', async () => {
    const data = new TextEncoder().encode('binary data');
    await adapter.writeFile('/bin.dat', data);
    const buf = await adapter.readFileBuffer('/bin.dat');
    assert.deepEqual(buf, data);
  });

  it('exists returns true for existing file', async () => {
    await adapter.writeFile('/exists.txt', 'yes');
    assert.equal(await adapter.exists('/exists.txt'), true);
  });

  it('exists returns false for non-existing file', async () => {
    assert.equal(await adapter.exists('/nope.txt'), false);
  });

  it('stat returns correct type for file', async () => {
    await adapter.writeFile('/file.txt', 'content');
    const s = await adapter.stat('/file.txt');
    assert.equal(s.isFile, true);
    assert.equal(s.isDirectory, false);
  });

  it('stat returns correct type for directory', async () => {
    await adapter.mkdir('/mydir');
    const s = await adapter.stat('/mydir');
    assert.equal(s.isDirectory, true);
    assert.equal(s.isFile, false);
  });

  it('mkdir recursive creates nested directories', async () => {
    await adapter.mkdir('/a/b/c', { recursive: true });
    assert.equal(await adapter.exists('/a/b/c'), true);
    const s = await adapter.stat('/a/b/c');
    assert.equal(s.isDirectory, true);
  });

  it('readdir lists entries', async () => {
    await adapter.mkdir('/dir-test');
    await adapter.writeFile('/dir-test/file1.txt', 'a');
    await adapter.writeFile('/dir-test/file2.txt', 'b');
    const entries = await adapter.readdir('/dir-test');
    assert.ok(entries.includes('file1.txt'));
    assert.ok(entries.includes('file2.txt'));
    assert.equal(entries.length, 2);
  });

  it('resolve handles relative paths from cwd', async () => {
    await adapter.mkdir('/workspace');
    await adapter.writeFile('/workspace/readme.md', 'hello');
    adapter.cwd = '/workspace';
    const content = await adapter.readFile('readme.md');
    assert.equal(content, 'hello');
  });

  it('rm removes file', async () => {
    await adapter.writeFile('/to-delete.txt', 'bye');
    await adapter.rm('/to-delete.txt');
    assert.equal(await adapter.exists('/to-delete.txt'), false);
  });

  it('rm recursive removes directory', async () => {
    await adapter.mkdir('/rmdir');
    await adapter.writeFile('/rmdir/child.txt', 'x');
    await adapter.rm('/rmdir', { recursive: true });
    assert.equal(await adapter.exists('/rmdir'), false);
  });

  it('cp copies file content', async () => {
    await adapter.writeFile('/src.txt', 'copy me');
    await adapter.cp('/src.txt', '/dst.txt');
    const content = await adapter.readFile('/dst.txt');
    assert.equal(content, 'copy me');
  });

  it('mv renames file', async () => {
    await adapter.writeFile('/old.txt', 'move me');
    await adapter.mv('/old.txt', '/new.txt');
    assert.equal(await adapter.exists('/old.txt'), false);
    const content = await adapter.readFile('/new.txt');
    assert.equal(content, 'move me');
  });

  it('resolvePath resolves relative to base', () => {
    assert.equal(adapter.resolvePath('/home', 'file.txt'), '/home/file.txt');
    assert.equal(adapter.resolvePath('/home/', 'file.txt'), '/home/file.txt');
    assert.equal(adapter.resolvePath('/home', '/absolute'), '/absolute');
  });

  it('readdirWithFileTypes returns type info', async () => {
    await adapter.mkdir('/typed');
    await adapter.writeFile('/typed/file.txt', 'x');
    await adapter.mkdir('/typed/sub');
    const entries = await adapter.readdirWithFileTypes('/typed');
    const file = entries.find(e => e.name === 'file.txt');
    const dir = entries.find(e => e.name === 'sub');
    assert.ok(file?.isFile);
    assert.ok(dir?.isDirectory);
  });
});

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { MemoryFsProvider } from './memory.ts';
import { FileSystemError } from '../provider.ts';

describe('MemoryFsProvider', () => {
  let fs: MemoryFsProvider;

  beforeEach(() => {
    fs = new MemoryFsProvider();
  });

  describe('create and read file', () => {
    it('should create a file and read it back', async () => {
      const handle = await fs.open('/hello.txt', { create: true, write: true, read: true });
      const data = new TextEncoder().encode('Hello, World!');
      await fs.write(handle, data, 0);
      const result = await fs.read(handle, 0, data.length);
      assert.deepStrictEqual(result, data);
      await fs.close(handle);
    });
  });

  describe('write and read with offsets', () => {
    it('should write at offset and read partial data', async () => {
      const handle = await fs.open('/data.bin', { create: true, write: true, read: true });
      const data1 = new Uint8Array([1, 2, 3, 4, 5]);
      const data2 = new Uint8Array([10, 20, 30]);
      await fs.write(handle, data1, 0);
      await fs.write(handle, data2, 2);
      const result = await fs.read(handle, 0, 5);
      assert.deepStrictEqual(result, new Uint8Array([1, 2, 10, 20, 30]));

      // Read with offset
      const partial = await fs.read(handle, 2, 2);
      assert.deepStrictEqual(partial, new Uint8Array([10, 20]));
      await fs.close(handle);
    });
  });

  describe('mkdir and readdir', () => {
    it('should create directory and list entries sorted', async () => {
      await fs.mkdir('/mydir');
      const h1 = await fs.open('/mydir/zebra.txt', { create: true, write: true });
      await fs.close(h1);
      const h2 = await fs.open('/mydir/alpha.txt', { create: true, write: true });
      await fs.close(h2);
      const h3 = await fs.open('/mydir/mid.txt', { create: true, write: true });
      await fs.close(h3);

      const entries = await fs.readdir('/mydir');
      assert.deepStrictEqual(entries.map(e => e.name), ['alpha.txt', 'mid.txt', 'zebra.txt']);
      assert.strictEqual(entries[0].type, 'file');
    });
  });

  describe('stat', () => {
    it('should return correct type, size, mode, and timestamps', async () => {
      const handle = await fs.open('/info.txt', { create: true, write: true });
      const data = new TextEncoder().encode('test content');
      await fs.write(handle, data, 0);
      await fs.close(handle);

      const stat = await fs.stat('/info.txt');
      assert.strictEqual(stat.type, 'file');
      assert.strictEqual(stat.size, BigInt(data.length));
      assert.strictEqual(stat.mode, 0o644);
      assert(stat.mtime instanceof Date);
      assert(stat.atime instanceof Date);
      assert(stat.ctime instanceof Date);
      assert.strictEqual(stat.linkCount, 1n);
    });

    it('should return directory type for directories', async () => {
      await fs.mkdir('/testdir');
      const stat = await fs.stat('/testdir');
      assert.strictEqual(stat.type, 'directory');
      assert.strictEqual(stat.mode, 0o755);
    });
  });

  describe('symlink', () => {
    it('should create and resolve symlinks', async () => {
      const handle = await fs.open('/target.txt', { create: true, write: true });
      const data = new TextEncoder().encode('symlink target');
      await fs.write(handle, data, 0);
      await fs.close(handle);

      await fs.symlink('/target.txt', '/link.txt');

      // stat with followSymlinks (default) resolves to file
      const stat = await fs.stat('/link.txt');
      assert.strictEqual(stat.type, 'file');
      assert.strictEqual(stat.size, BigInt(data.length));

      // stat without followSymlinks returns symlink
      const linkStat = await fs.stat('/link.txt', { followSymlinks: false });
      assert.strictEqual(linkStat.type, 'symlink');

      // readlink returns target
      const target = await fs.readlink('/link.txt');
      assert.strictEqual(target, '/target.txt');
    });

    it('should detect symlink loops', async () => {
      await fs.symlink('/b', '/a');
      await fs.symlink('/a', '/b');

      assert.throws(
        () => fs.stat('/a'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'loop'
      );
    });
  });

  describe('chmod', () => {
    it('should update mode and ctime', async () => {
      const handle = await fs.open('/chmod.txt', { create: true, write: true });
      await fs.close(handle);

      const statBefore = await fs.stat('/chmod.txt');
      assert.strictEqual(statBefore.mode, 0o644);

      await fs.chmod('/chmod.txt', 0o755);
      const statAfter = await fs.stat('/chmod.txt');
      assert.strictEqual(statAfter.mode, 0o755);
      assert(statAfter.ctime >= statBefore.ctime);
    });
  });

  describe('unlink and rmdir', () => {
    it('should unlink a file', async () => {
      const handle = await fs.open('/remove.txt', { create: true, write: true });
      await fs.close(handle);

      await fs.unlink('/remove.txt');
      assert.throws(
        () => fs.stat('/remove.txt'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
      );
    });

    it('should rmdir an empty directory', async () => {
      await fs.mkdir('/emptydir');
      await fs.rmdir('/emptydir');
      assert.throws(
        () => fs.stat('/emptydir'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
      );
    });

    it('should fail rmdir on non-empty directory', async () => {
      await fs.mkdir('/fulldir');
      const h = await fs.open('/fulldir/child.txt', { create: true, write: true });
      await fs.close(h);

      assert.throws(
        () => fs.rmdir('/fulldir'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'not-empty'
      );
    });
  });

  describe('rename', () => {
    it('should rename a file', async () => {
      const handle = await fs.open('/old.txt', { create: true, write: true });
      const data = new TextEncoder().encode('content');
      await fs.write(handle, data, 0);
      await fs.close(handle);

      await fs.rename('/old.txt', '/new.txt');

      assert.throws(
        () => fs.stat('/old.txt'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
      );

      const stat = await fs.stat('/new.txt');
      assert.strictEqual(stat.type, 'file');
      assert.strictEqual(stat.size, BigInt(data.length));
    });
  });

  describe('open flags', () => {
    it('should create file with create flag', async () => {
      const handle = await fs.open('/created.txt', { create: true, write: true });
      await fs.close(handle);
      const stat = await fs.stat('/created.txt');
      assert.strictEqual(stat.type, 'file');
    });

    it('should truncate file with truncate flag', async () => {
      const h1 = await fs.open('/trunc.txt', { create: true, write: true });
      await fs.write(h1, new TextEncoder().encode('hello'), 0);
      await fs.close(h1);

      const h2 = await fs.open('/trunc.txt', { truncate: true, write: true });
      const data = await fs.read(h2, 0, 100);
      assert.strictEqual(data.length, 0);
      await fs.close(h2);
    });

    it('should fail with exclusive flag if file exists', async () => {
      const h = await fs.open('/exclusive.txt', { create: true, write: true });
      await fs.close(h);

      assert.throws(
        () => fs.open('/exclusive.txt', { create: true, exclusive: true }),
        (err: unknown) => err instanceof FileSystemError && err.code === 'exist'
      );
    });

    it('should fail without create flag if file does not exist', async () => {
      assert.throws(
        () => fs.open('/nonexistent.txt', { read: true }),
        (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
      );
    });
  });

  describe('file handles', () => {
    it('should open and close handle', async () => {
      const handle = await fs.open('/handle.txt', { create: true, write: true, read: true });
      const data = new TextEncoder().encode('handle data');
      await fs.write(handle, data, 0);
      const result = await fs.read(handle, 0, data.length);
      assert.deepStrictEqual(result, data);
      await fs.close(handle);
    });

    it('should fail read on closed handle', async () => {
      const handle = await fs.open('/closed.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('data'), 0);
      await fs.close(handle);

      assert.throws(
        () => fs.read(handle, 0, 4),
        (err: unknown) => err instanceof FileSystemError && err.code === 'invalid'
      );
    });
  });

  describe('constructor with initial files', () => {
    it('should initialize with provided files', async () => {
      const provider = new MemoryFsProvider({
        files: {
          '/a/b/c.txt': 'hello',
          '/x.bin': new Uint8Array([1, 2, 3]),
          '/custom.txt': { content: 'custom', mode: 0o600, mtime: new Date(1000) },
        },
      });

      const stat1 = await provider.stat('/a/b/c.txt');
      assert.strictEqual(stat1.type, 'file');

      const stat2 = await provider.stat('/x.bin');
      assert.strictEqual(stat2.size, 3n);

      const stat3 = await provider.stat('/custom.txt');
      assert.strictEqual(stat3.mode, 0o600);
      assert.strictEqual(stat3.mtime.getTime(), 1000);
    });
  });

  describe('link', () => {
    it('should create hard link and both paths read same content', async () => {
      const handle = await fs.open('/original.txt', { create: true, write: true, read: true });
      const data = new TextEncoder().encode('linked content');
      await fs.write(handle, data, 0);
      await fs.close(handle);

      await fs.link('/original.txt', '/hardlink.txt');

      // Read via original
      const h1 = await fs.open('/original.txt', { read: true });
      const content1 = await fs.read(h1, 0, 100);
      await fs.close(h1);

      // Read via hard link
      const h2 = await fs.open('/hardlink.txt', { read: true });
      const content2 = await fs.read(h2, 0, 100);
      await fs.close(h2);

      assert.deepStrictEqual(content1, data);
      assert.deepStrictEqual(content2, data);
    });

    it('should share the same underlying data after modification', async () => {
      const handle = await fs.open('/src.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('hello'), 0);
      await fs.close(handle);

      await fs.link('/src.txt', '/link.txt');

      // Modify via original
      const h1 = await fs.open('/src.txt', { write: true });
      await fs.write(h1, new TextEncoder().encode('world'), 0);
      await fs.close(h1);

      // Read via link should see updated content
      const h2 = await fs.open('/link.txt', { read: true });
      const content = await fs.read(h2, 0, 100);
      await fs.close(h2);

      assert.deepStrictEqual(content, new TextEncoder().encode('world'));
    });
  });

  describe('utimes', () => {
    it('should set timestamps and verify stat returns updated values', async () => {
      const handle = await fs.open('/utimes.txt', { create: true, write: true });
      await fs.close(handle);

      const newAtime = new Date(2000000000);
      const newMtime = new Date(3000000000);
      await fs.utimes('/utimes.txt', newAtime, newMtime);

      const stat = await fs.stat('/utimes.txt');
      assert.strictEqual(stat.atime.getTime(), 2000000000);
      assert.strictEqual(stat.mtime.getTime(), 3000000000);
    });
  });

  describe('realpath', () => {
    it('should resolve symlinks in path to canonical path', async () => {
      await fs.mkdir('/real');
      const handle = await fs.open('/real/file.txt', { create: true, write: true });
      await fs.close(handle);

      await fs.symlink('/real', '/alias');

      const resolved = await fs.realpath('/alias/file.txt');
      assert.strictEqual(resolved, '/real/file.txt');
    });

    it('should return the same path for a path with no symlinks', async () => {
      await fs.mkdir('/plain');
      const handle = await fs.open('/plain/doc.txt', { create: true, write: true });
      await fs.close(handle);

      const resolved = await fs.realpath('/plain/doc.txt');
      assert.strictEqual(resolved, '/plain/doc.txt');
    });
  });

  describe('truncate', () => {
    it('should truncate file to smaller size and verify content', async () => {
      const handle = await fs.open('/trunc.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('Hello, World!'), 0);

      await fs.truncate(handle, 5);

      const content = await fs.read(handle, 0, 100);
      assert.deepStrictEqual(content, new TextEncoder().encode('Hello'));
      await fs.close(handle);
    });

    it('should expand file when truncating to larger size', async () => {
      const handle = await fs.open('/expand.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('Hi'), 0);

      await fs.truncate(handle, 5);

      const content = await fs.read(handle, 0, 5);
      assert.strictEqual(content.length, 5);
      assert.strictEqual(content[0], 72); // 'H'
      assert.strictEqual(content[1], 105); // 'i'
      assert.strictEqual(content[2], 0);
      assert.strictEqual(content[3], 0);
      assert.strictEqual(content[4], 0);
      await fs.close(handle);
    });
  });

  describe('write at offset', () => {
    it('should write at offset > 0 and verify content', async () => {
      const handle = await fs.open('/offset-write.txt', { create: true, write: true, read: true });
      // Write initial content
      await fs.write(handle, new TextEncoder().encode('AAAA'), 0);
      // Write at offset 2
      await fs.write(handle, new TextEncoder().encode('BB'), 2);

      const content = await fs.read(handle, 0, 4);
      assert.deepStrictEqual(content, new TextEncoder().encode('AABB'));
      await fs.close(handle);
    });

    it('should extend file when writing beyond current length', async () => {
      const handle = await fs.open('/extend.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('AB'), 0);
      // Write at offset 5 (beyond end)
      await fs.write(handle, new TextEncoder().encode('CD'), 5);

      const content = await fs.read(handle, 0, 7);
      assert.strictEqual(content.length, 7);
      assert.strictEqual(content[0], 65); // 'A'
      assert.strictEqual(content[1], 66); // 'B'
      assert.strictEqual(content[2], 0);  // zero-filled gap
      assert.strictEqual(content[3], 0);
      assert.strictEqual(content[4], 0);
      assert.strictEqual(content[5], 67); // 'C'
      assert.strictEqual(content[6], 68); // 'D'
      await fs.close(handle);
    });
  });

  describe('read at offset', () => {
    it('should read from middle of file', async () => {
      const handle = await fs.open('/middle.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('abcdefgh'), 0);

      const content = await fs.read(handle, 3, 3);
      assert.deepStrictEqual(content, new TextEncoder().encode('def'));
      await fs.close(handle);
    });

    it('should return empty when reading at offset beyond file size', async () => {
      const handle = await fs.open('/beyond.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('short'), 0);

      const content = await fs.read(handle, 100, 10);
      assert.strictEqual(content.length, 0);
      await fs.close(handle);
    });
  });

  describe('large file', () => {
    it('should write > 4096 bytes and read back correctly', async () => {
      const handle = await fs.open('/large.bin', { create: true, write: true, read: true });
      const size = 8192;
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }
      await fs.write(handle, data, 0);

      const result = await fs.read(handle, 0, size);
      assert.strictEqual(result.length, size);
      assert.deepStrictEqual(result, data);

      // Verify stat shows correct size
      await fs.close(handle);
      const stat = await fs.stat('/large.bin');
      assert.strictEqual(stat.size, BigInt(size));
    });

    it('should handle reading a partial chunk from a large file', async () => {
      const handle = await fs.open('/large2.bin', { create: true, write: true, read: true });
      const size = 10000;
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }
      await fs.write(handle, data, 0);

      // Read 1000 bytes starting at offset 5000
      const result = await fs.read(handle, 5000, 1000);
      assert.strictEqual(result.length, 1000);
      assert.deepStrictEqual(result, data.slice(5000, 6000));
      await fs.close(handle);
    });
  });
});

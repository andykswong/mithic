import { expect, describe, it, beforeEach } from 'vitest';
import { MemoryFsProvider } from './memory.ts';
import { FileSystemError } from '../provider.ts';

function expectThrows<T extends Error = Error>(fn: () => unknown): T {
  let err: T | undefined;
  expect(() => { try { fn(); } catch (e) { err = e as T; throw e; } }).toThrow();
  return err!;
}

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
      expect(result).toEqual(data);
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
      expect(result).toEqual(new Uint8Array([1, 2, 10, 20, 30]));

      // Read with offset
      const partial = await fs.read(handle, 2, 2);
      expect(partial).toEqual(new Uint8Array([10, 20]));
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
      expect(entries.map(e => e.name)).toEqual(['alpha.txt', 'mid.txt', 'zebra.txt']);
      expect(entries[0].type).toBe('file');
    });
  });

  describe('stat', () => {
    it('should return correct type, size, mode, and timestamps', async () => {
      const handle = await fs.open('/info.txt', { create: true, write: true });
      const data = new TextEncoder().encode('test content');
      await fs.write(handle, data, 0);
      await fs.close(handle);

      const stat = await fs.stat('/info.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(BigInt(data.length));
      expect(stat.mode).toBe(0o644);
      expect(stat.mtime).toBeInstanceOf(Date);
      expect(stat.atime).toBeInstanceOf(Date);
      expect(stat.ctime).toBeInstanceOf(Date);
      expect(stat.linkCount).toBe(1n);
    });

    it('should return directory type for directories', async () => {
      await fs.mkdir('/testdir');
      const stat = await fs.stat('/testdir');
      expect(stat.type).toBe('directory');
      expect(stat.mode).toBe(0o755);
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
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(BigInt(data.length));

      // stat without followSymlinks returns symlink
      const linkStat = await fs.stat('/link.txt', { followSymlinks: false });
      expect(linkStat.type).toBe('symlink');

      // readlink returns target
      const target = await fs.readlink('/link.txt');
      expect(target).toBe('/target.txt');
    });

    it('should detect symlink loops', async () => {
      await fs.symlink('/b', '/a');
      await fs.symlink('/a', '/b');

      const err = expectThrows<FileSystemError>(() => fs.stat('/a'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('loop');
    });
  });

  describe('chmod', () => {
    it('should update mode and ctime', async () => {
      const handle = await fs.open('/chmod.txt', { create: true, write: true });
      await fs.close(handle);

      const statBefore = await fs.stat('/chmod.txt');
      expect(statBefore.mode).toBe(0o644);

      await fs.chmod('/chmod.txt', 0o755);
      const statAfter = await fs.stat('/chmod.txt');
      expect(statAfter.mode).toBe(0o755);
      expect(statAfter.ctime >= statBefore.ctime).toBe(true);
    });
  });

  describe('unlink and rmdir', () => {
    it('should unlink a file', async () => {
      const handle = await fs.open('/remove.txt', { create: true, write: true });
      await fs.close(handle);

      await fs.unlink('/remove.txt');
      const err = expectThrows<FileSystemError>(() => fs.stat('/remove.txt'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });

    it('should rmdir an empty directory', async () => {
      await fs.mkdir('/emptydir');
      await fs.rmdir('/emptydir');
      const err = expectThrows<FileSystemError>(() => fs.stat('/emptydir'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });

    it('should fail rmdir on non-empty directory', async () => {
      await fs.mkdir('/fulldir');
      const h = await fs.open('/fulldir/child.txt', { create: true, write: true });
      await fs.close(h);

      const err = expectThrows<FileSystemError>(() => fs.rmdir('/fulldir'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-empty');
    });
  });

  describe('rename', () => {
    it('should rename a file', async () => {
      const handle = await fs.open('/old.txt', { create: true, write: true });
      const data = new TextEncoder().encode('content');
      await fs.write(handle, data, 0);
      await fs.close(handle);

      await fs.rename('/old.txt', '/new.txt');

      const err = expectThrows<FileSystemError>(() => fs.stat('/old.txt'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');

      const stat = await fs.stat('/new.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(BigInt(data.length));
    });
  });

  describe('open flags', () => {
    it('should create file with create flag', async () => {
      const handle = await fs.open('/created.txt', { create: true, write: true });
      await fs.close(handle);
      const stat = await fs.stat('/created.txt');
      expect(stat.type).toBe('file');
    });

    it('should truncate file with truncate flag', async () => {
      const h1 = await fs.open('/trunc.txt', { create: true, write: true });
      await fs.write(h1, new TextEncoder().encode('hello'), 0);
      await fs.close(h1);

      const h2 = await fs.open('/trunc.txt', { truncate: true, write: true });
      const data = await fs.read(h2, 0, 100);
      expect(data.length).toBe(0);
      await fs.close(h2);
    });

    it('should fail with exclusive flag if file exists', async () => {
      const h = await fs.open('/exclusive.txt', { create: true, write: true });
      await fs.close(h);

      const err = expectThrows<FileSystemError>(() => fs.open('/exclusive.txt', { create: true, exclusive: true }));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('exist');
    });

    it('should fail without create flag if file does not exist', async () => {
      const err = expectThrows<FileSystemError>(() => fs.open('/nonexistent.txt', { read: true }));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });
  });

  describe('file handles', () => {
    it('should open and close handle', async () => {
      const handle = await fs.open('/handle.txt', { create: true, write: true, read: true });
      const data = new TextEncoder().encode('handle data');
      await fs.write(handle, data, 0);
      const result = await fs.read(handle, 0, data.length);
      expect(result).toEqual(data);
      await fs.close(handle);
    });

    it('should fail read on closed handle', async () => {
      const handle = await fs.open('/closed.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('data'), 0);
      await fs.close(handle);

      const err = expectThrows<FileSystemError>(() => fs.read(handle, 0, 4));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('invalid');
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
      expect(stat1.type).toBe('file');

      const stat2 = await provider.stat('/x.bin');
      expect(stat2.size).toBe(3n);

      const stat3 = await provider.stat('/custom.txt');
      expect(stat3.mode).toBe(0o600);
      expect(stat3.mtime.getTime()).toBe(1000);
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

      expect(content1).toEqual(data);
      expect(content2).toEqual(data);
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

      expect(content).toEqual(new TextEncoder().encode('world'));
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
      expect(stat.atime.getTime()).toBe(2000000000);
      expect(stat.mtime.getTime()).toBe(3000000000);
    });
  });

  describe('realpath', () => {
    it('should resolve symlinks in path to canonical path', async () => {
      await fs.mkdir('/real');
      const handle = await fs.open('/real/file.txt', { create: true, write: true });
      await fs.close(handle);

      await fs.symlink('/real', '/alias');

      const resolved = await fs.realpath('/alias/file.txt');
      expect(resolved).toBe('/real/file.txt');
    });

    it('should return the same path for a path with no symlinks', async () => {
      await fs.mkdir('/plain');
      const handle = await fs.open('/plain/doc.txt', { create: true, write: true });
      await fs.close(handle);

      const resolved = await fs.realpath('/plain/doc.txt');
      expect(resolved).toBe('/plain/doc.txt');
    });
  });

  describe('mkfifo', () => {
    it('should create a fifo node and stat returns type fifo', () => {
      fs.mkfifo('/myfifo');
      const stat = fs.stat('/myfifo');
      expect(stat.type).toBe('fifo');
      expect(stat.size).toBe(0n);
      expect(stat.mode).toBe(0o644);
    });

    it('should write to fifo and read dequeues data', () => {
      fs.mkfifo('/pipe');
      const handle = fs.open('/pipe', { write: true, read: true });
      const data1 = new TextEncoder().encode('hello');
      const data2 = new TextEncoder().encode('world');
      fs.write(handle, data1, 0);
      fs.write(handle, data2, 0);

      const read1 = fs.read(handle, 0, 1024);
      expect(read1).toEqual(data1);

      const read2 = fs.read(handle, 0, 1024);
      expect(read2).toEqual(data2);

      fs.close(handle);
    });

    it('should return empty array when reading from empty fifo', () => {
      fs.mkfifo('/empty-pipe');
      const handle = fs.open('/empty-pipe', { read: true });
      const data = fs.read(handle, 0, 1024);
      expect(data.length).toBe(0);
      fs.close(handle);
    });

    it('should throw if path already exists', () => {
      fs.mkfifo('/existing-fifo');
      const err = expectThrows<FileSystemError>(() => fs.mkfifo('/existing-fifo'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('exist');
    });

    it('should throw if parent directory does not exist', () => {
      const err = expectThrows<FileSystemError>(() => fs.mkfifo('/nonexistent/fifo'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });

    it('should be removable with unlink', () => {
      fs.mkfifo('/removable-fifo');
      fs.unlink('/removable-fifo');
      const err = expectThrows<FileSystemError>(() => fs.stat('/removable-fifo'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });

    it('should appear in readdir listings', () => {
      fs.mkdir('/fifodir');
      fs.mkfifo('/fifodir/mypipe');
      const entries = fs.readdir('/fifodir');
      expect(entries.length).toBe(1);
      expect(entries[0].name).toBe('mypipe');
      expect(entries[0].type).toBe('fifo');
    });
  });

  describe('truncate', () => {
    it('should truncate file to smaller size and verify content', async () => {
      const handle = await fs.open('/trunc.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('Hello, World!'), 0);

      await fs.truncate(handle, 5);

      const content = await fs.read(handle, 0, 100);
      expect(content).toEqual(new TextEncoder().encode('Hello'));
      await fs.close(handle);
    });

    it('should expand file when truncating to larger size', async () => {
      const handle = await fs.open('/expand.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('Hi'), 0);

      await fs.truncate(handle, 5);

      const content = await fs.read(handle, 0, 5);
      expect(content.length).toBe(5);
      expect(content[0]).toBe(72); // 'H'
      expect(content[1]).toBe(105); // 'i'
      expect(content[2]).toBe(0);
      expect(content[3]).toBe(0);
      expect(content[4]).toBe(0);
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
      expect(content).toEqual(new TextEncoder().encode('AABB'));
      await fs.close(handle);
    });

    it('should extend file when writing beyond current length', async () => {
      const handle = await fs.open('/extend.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('AB'), 0);
      // Write at offset 5 (beyond end)
      await fs.write(handle, new TextEncoder().encode('CD'), 5);

      const content = await fs.read(handle, 0, 7);
      expect(content.length).toBe(7);
      expect(content[0]).toBe(65); // 'A'
      expect(content[1]).toBe(66); // 'B'
      expect(content[2]).toBe(0);  // zero-filled gap
      expect(content[3]).toBe(0);
      expect(content[4]).toBe(0);
      expect(content[5]).toBe(67); // 'C'
      expect(content[6]).toBe(68); // 'D'
      await fs.close(handle);
    });
  });

  describe('read at offset', () => {
    it('should read from middle of file', async () => {
      const handle = await fs.open('/middle.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('abcdefgh'), 0);

      const content = await fs.read(handle, 3, 3);
      expect(content).toEqual(new TextEncoder().encode('def'));
      await fs.close(handle);
    });

    it('should return empty when reading at offset beyond file size', async () => {
      const handle = await fs.open('/beyond.txt', { create: true, write: true, read: true });
      await fs.write(handle, new TextEncoder().encode('short'), 0);

      const content = await fs.read(handle, 100, 10);
      expect(content.length).toBe(0);
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
      expect(result.length).toBe(size);
      expect(result).toEqual(data);

      // Verify stat shows correct size
      await fs.close(handle);
      const stat = await fs.stat('/large.bin');
      expect(stat.size).toBe(BigInt(size));
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
      expect(result.length).toBe(1000);
      expect(result).toEqual(data.slice(5000, 6000));
      await fs.close(handle);
    });
  });
});

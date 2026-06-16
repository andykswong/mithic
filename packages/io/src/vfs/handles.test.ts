import { expect, describe, it, beforeEach } from 'vitest';
import { MemoryFsProvider } from './providers/memory.ts';
import { FileSystemRouter } from './router.ts';
import { VFSDirectoryHandle } from './handles.ts';

describe('VFS Handles', () => {
  let router: FileSystemRouter;
  let root: VFSDirectoryHandle;

  beforeEach(async () => {
    router = new FileSystemRouter();
    await router.mount('/', new MemoryFsProvider());
    root = new VFSDirectoryHandle(router, '/');
  });

  describe('VFSDirectoryHandle.getFileHandle', () => {
    it('should create a file with create option', async () => {
      const fileHandle = await root.getFileHandle('test.txt', { create: true });
      expect(fileHandle.kind).toBe('file');
      expect(fileHandle.name).toBe('test.txt');
    });

    it('should throw NotFoundError without create if file missing', async () => {
      await expect(
        root.getFileHandle('nonexistent.txt'),
      ).rejects.toSatisfy((err: unknown) => (err as DOMException).name === 'NotFoundError');
    });

    it('should return existing file handle without create', async () => {
      await root.getFileHandle('existing.txt', { create: true });
      const handle = await root.getFileHandle('existing.txt');
      expect(handle.name).toBe('existing.txt');
    });
  });

  describe('VFSDirectoryHandle.getDirectoryHandle', () => {
    it('should create a directory with create option', async () => {
      const dirHandle = await root.getDirectoryHandle('subdir', { create: true });
      expect(dirHandle.kind).toBe('directory');
      expect(dirHandle.name).toBe('subdir');
    });

    it('should throw NotFoundError without create if directory missing', async () => {
      await expect(
        root.getDirectoryHandle('nodir'),
      ).rejects.toSatisfy((err: unknown) => (err as DOMException).name === 'NotFoundError');
    });
  });

  describe('entries()', () => {
    it('should iterate directory contents', async () => {
      await root.getFileHandle('a.txt', { create: true });
      await root.getFileHandle('b.txt', { create: true });
      await root.getDirectoryHandle('c', { create: true });

      const entries: [string, FileSystemHandle][] = [];
      for await (const entry of root.entries()) {
        entries.push(entry);
      }

      const names = entries.map(([name]) => name).sort();
      expect(names).toEqual(['a.txt', 'b.txt', 'c']);

      const types = new Map(entries.map(([name, handle]) => [name, handle.kind]));
      expect(types.get('a.txt')).toBe('file');
      expect(types.get('c')).toBe('directory');
    });
  });

  describe('VFSFileHandle.getFile()', () => {
    it('should return File with correct content', async () => {
      // Write some data via the router
      const handle = await router.open('/data.txt', { create: true, write: true });
      const content = new TextEncoder().encode('file contents here');
      await router.write(handle, content, 0);
      await router.close(handle);

      const fileHandle = await root.getFileHandle('data.txt');
      const file = await fileHandle.getFile();
      expect(file.name).toBe('data.txt');
      expect(file.size).toBe(content.length);

      const text = await file.text();
      expect(text).toBe('file contents here');
    });
  });

  describe('VFSFileHandle.createWritable()', () => {
    it('should write and close persists data', async () => {
      const fileHandle = await root.getFileHandle('writable.txt', { create: true });
      const writable = await fileHandle.createWritable();
      const writer = writable.getWriter();
      await writer.write(new TextEncoder().encode('hello writable'));
      await writer.close();

      // Verify data persisted
      const file = await fileHandle.getFile();
      const text = await file.text();
      expect(text).toBe('hello writable');
    });

    it('should support write with keepExistingData', async () => {
      // Write initial data
      const handle = await router.open('/keep.txt', { create: true, write: true });
      await router.write(handle, new TextEncoder().encode('ABCDEF'), 0);
      await router.close(handle);

      const fileHandle = await root.getFileHandle('keep.txt');
      const writable = await fileHandle.createWritable({ keepExistingData: true });
      const writer = writable.getWriter();
      // Write at beginning overwrites
      await writer.write(new TextEncoder().encode('XY'));
      await writer.close();

      const file = await fileHandle.getFile();
      const text = await file.text();
      expect(text).toBe('XYCDEF');
    });
  });

  describe('removeEntry()', () => {
    it('should remove a file', async () => {
      await root.getFileHandle('remove-me.txt', { create: true });
      await root.removeEntry('remove-me.txt');

      await expect(
        root.getFileHandle('remove-me.txt'),
      ).rejects.toSatisfy((err: unknown) => (err as DOMException).name === 'NotFoundError');
    });

    it('should remove directory recursively', async () => {
      const subdir = await root.getDirectoryHandle('deep', { create: true });
      await subdir.getFileHandle('nested.txt', { create: true });

      await root.removeEntry('deep', { recursive: true });

      await expect(
        root.getDirectoryHandle('deep'),
      ).rejects.toSatisfy((err: unknown) => (err as DOMException).name === 'NotFoundError');
    });
  });

  describe('resolve()', () => {
    it('should return path segments to descendant', async () => {
      const sub = await root.getDirectoryHandle('dir1', { create: true });
      const sub2 = await sub.getDirectoryHandle('dir2', { create: true });
      const file = await sub2.getFileHandle('deep.txt', { create: true });

      const result = await root.resolve(file);
      expect(result).toEqual(['dir1', 'dir2', 'deep.txt']);
    });

    it('should return empty array for same entry', async () => {
      const result = await root.resolve(root);
      expect(result).toEqual([]);
    });

    it('should return null for non-descendant', async () => {
      const other = new VFSDirectoryHandle(router, '/other');
      const sub = await root.getDirectoryHandle('inside', { create: true });
      const result = await other.resolve(sub);
      expect(result).toBeNull();
    });
  });

  describe('stat() extension', () => {
    it('should return FileStat for directory', async () => {
      await root.getDirectoryHandle('statdir', { create: true });
      const dirHandle = await root.getDirectoryHandle('statdir');
      const stat = await dirHandle.stat();
      expect(stat.type).toBe('directory');
      expect(stat.mode).toBe(0o755);
    });

    it('should return FileStat for file', async () => {
      const handle = await router.open('/statfile.txt', { create: true, write: true });
      await router.write(handle, new TextEncoder().encode('stat data'), 0);
      await router.close(handle);

      const fileHandle = await root.getFileHandle('statfile.txt');
      const stat = await fileHandle.stat();
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(9n);
    });
  });

  describe('chmod() extension', () => {
    it('should update mode', async () => {
      const handle = await router.open('/chmodfile.txt', { create: true, write: true });
      await router.close(handle);

      const fileHandle = await root.getFileHandle('chmodfile.txt');
      await fileHandle.chmod(0o600);

      const stat = await fileHandle.stat();
      expect(stat.mode).toBe(0o600);
    });
  });
});

import { expect, describe, it, beforeEach } from 'vitest';
import { SyncFileSystemRouter } from './sync-router.ts';
import { MemoryFsProvider } from './providers/memory.ts';
import { DeviceFsProvider } from './providers/device.ts';
import { FileSystemError } from './provider.ts';

function expectThrows<T extends Error = Error>(fn: () => unknown): T {
  let err: T | undefined;
  expect(() => { try { fn(); } catch (e) { err = e as T; throw e; } }).toThrow();
  return err!;
}

describe('SyncFileSystemRouter', () => {
  let router: SyncFileSystemRouter;
  let memFs: MemoryFsProvider;

  beforeEach(() => {
    router = new SyncFileSystemRouter();
    memFs = new MemoryFsProvider();
    router.mount('/', memFs);
  });

  describe('basic routing', () => {
    it('reads and writes files via root mount', () => {
      const handle = router.open('/test.txt', { create: true, write: true });
      router.write(handle, new TextEncoder().encode('hello'), 0);
      router.close(handle);

      const rHandle = router.open('/test.txt', { read: true });
      const data = router.read(rHandle, 0, 100);
      expect(new TextDecoder().decode(data)).toBe('hello');
      router.close(rHandle);
    });

    it('mkdir and readdir work', () => {
      router.mkdir('/mydir');
      const entries = router.readdir('/');
      expect(entries.some(e => e.name === 'mydir')).toBe(true);
    });

    it('stat returns file metadata', () => {
      const handle = router.open('/stat.txt', { create: true, write: true });
      router.close(handle);
      const stat = router.stat('/stat.txt');
      expect(stat.type).toBe('file');
    });
  });

  describe('mount routing', () => {
    it('routes /dev paths to DeviceFsProvider', () => {
      router.mount('/dev', new DeviceFsProvider());
      const stat = router.stat('/dev/null');
      expect(stat.type).toBe('character-device');
    });

    it('/dev/null accepts writes and returns empty on read', () => {
      router.mount('/dev', new DeviceFsProvider());
      const wHandle = router.open('/dev/null', { write: true });
      const written = router.write(wHandle, new Uint8Array([1, 2, 3]), 0);
      expect(written).toBe(3);
      router.close(wHandle);

      const rHandle = router.open('/dev/null', { read: true });
      const data = router.read(rHandle, 0, 100);
      expect(data.byteLength).toBe(0);
      router.close(rHandle);
    });

    it('/dev/zero returns zeroed bytes', () => {
      router.mount('/dev', new DeviceFsProvider());
      const handle = router.open('/dev/zero', { read: true });
      const data = router.read(handle, 0, 8);
      expect(data.byteLength).toBe(8);
      expect(data.every(b => b === 0)).toBe(true);
      router.close(handle);
    });

    it('longest prefix wins for nested mounts', () => {
      const innerFs = new MemoryFsProvider();
      router.mount('/mnt/data', innerFs);
      const handle = router.open('/mnt/data/file.txt', { create: true, write: true });
      router.write(handle, new TextEncoder().encode('inner'), 0);
      router.close(handle);

      const rHandle = router.open('/mnt/data/file.txt', { read: true });
      const data = router.read(rHandle, 0, 100);
      expect(new TextDecoder().decode(data)).toBe('inner');
      router.close(rHandle);
    });

    it('throws no-entry for unmounted path with no root', () => {
      const emptyRouter = new SyncFileSystemRouter();
      const err = expectThrows<FileSystemError>(() => emptyRouter.stat('/anything'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });
  });

  describe('cross-mount operations', () => {
    it('rename across mounts throws cross-device', () => {
      const otherFs = new MemoryFsProvider();
      router.mount('/other', otherFs);
      const handle = router.open('/file.txt', { create: true, write: true });
      router.close(handle);

      const err = expectThrows<FileSystemError>(() => router.rename('/file.txt', '/other/file.txt'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('cross-device');
    });
  });

  describe('unmount', () => {
    it('unmount removes the mount point', () => {
      router.mount('/dev', new DeviceFsProvider());
      router.unmount('/dev');
      const err = expectThrows<FileSystemError>(() => router.stat('/dev/null'));
      expect(err).toBeInstanceOf(FileSystemError);
    });
  });

  describe('readdir includes mount points', () => {
    it('readdir / includes mount point entries', () => {
      memFs.mkdir('/home');
      router.mount('/dev', new DeviceFsProvider());

      const entries = router.readdir('/');
      const names = entries.map(e => e.name);
      expect(names).toContain('home');
      expect(names).toContain('dev');
    });

    it('readdir / does not duplicate entries', () => {
      memFs.mkdir('/dev');
      router.mount('/dev', new DeviceFsProvider());

      const entries = router.readdir('/');
      const devEntries = entries.filter(e => e.name === 'dev');
      expect(devEntries.length).toBe(1);
    });

    it('readdir /tmp does not inject top-level mounts', () => {
      memFs.mkdir('/tmp');
      router.mount('/dev', new DeviceFsProvider());

      const entries = router.readdir('/tmp');
      const names = entries.map(e => e.name);
      expect(names).not.toContain('dev');
    });

    it('nested mount appears in parent readdir', () => {
      memFs.mkdir('/mnt');
      router.mount('/mnt/usb', new MemoryFsProvider());

      const entries = router.readdir('/mnt');
      const names = entries.map(e => e.name);
      expect(names).toContain('usb');
    });
  });
});

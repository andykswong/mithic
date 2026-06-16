import { expect, describe, it, beforeEach } from 'vitest';
import { FileSystemRouter } from './router.ts';
import { FileSystemError } from './provider.ts';
import { MemoryFsProvider } from './providers/memory.ts';

function expectThrows<T extends Error = Error>(fn: () => unknown): T {
  let err: T | undefined;
  expect(() => { try { fn(); } catch (e) { err = e as T; throw e; } }).toThrow();
  return err!;
}

describe('FileSystemRouter', () => {
  let router: FileSystemRouter;
  let rootProvider: MemoryFsProvider;
  let homeProvider: MemoryFsProvider;

  beforeEach(async () => {
    router = new FileSystemRouter();
    rootProvider = new MemoryFsProvider({
      files: { '/etc/config.txt': 'root config' },
    });
    homeProvider = new MemoryFsProvider({
      files: { '/user/file.txt': 'home file' },
    });
    await router.mount('/', rootProvider);
    await router.mount('/home', homeProvider);
  });

  describe('mount and resolve', () => {
    it('should resolve root mount for paths not under other mounts', () => {
      const result = router.resolve('/etc/config.txt');
      expect(result.provider).toBe(rootProvider);
      expect(result.relativePath).toBe('etc/config.txt');
      expect(result.mountPoint).toBe('/');
    });

    it('should resolve longest prefix mount', () => {
      const result = router.resolve('/home/user/file.txt');
      expect(result.provider).toBe(homeProvider);
      expect(result.relativePath).toBe('user/file.txt');
      expect(result.mountPoint).toBe('/home');
    });

    it('should resolve root path to root mount', () => {
      const result = router.resolve('/');
      expect(result.provider).toBe(rootProvider);
      expect(result.relativePath).toBe('/');
      expect(result.mountPoint).toBe('/');
    });

    it('should resolve mount point itself', () => {
      const result = router.resolve('/home');
      expect(result.provider).toBe(homeProvider);
      expect(result.relativePath).toBe('/');
      expect(result.mountPoint).toBe('/home');
    });
  });

  describe('path normalization', () => {
    it('should handle trailing slashes', () => {
      const result = router.resolve('/home/user/');
      expect(result.provider).toBe(homeProvider);
      expect(result.relativePath).toBe('user');
    });

    it('should handle double slashes', () => {
      const result = router.resolve('/home//user//file.txt');
      expect(result.provider).toBe(homeProvider);
      expect(result.relativePath).toBe('user/file.txt');
    });

    it('should resolve dot segments', () => {
      const result = router.resolve('/home/user/../user/./file.txt');
      expect(result.provider).toBe(homeProvider);
      expect(result.relativePath).toBe('user/file.txt');
    });
  });

  describe('no-entry error', () => {
    it('should throw no-entry when no mount matches', async () => {
      const emptyRouter = new FileSystemRouter();
      const err = expectThrows<FileSystemError>(() => emptyRouter.resolve('/some/path'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });
  });

  describe('cross-mount operations', () => {
    it('should throw cross-device error on rename across mounts', async () => {
      await expect(
        router.rename('/etc/config.txt', '/home/user/config.txt'),
      ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'cross-device');
    });

    it('should throw cross-device error on link across mounts', async () => {
      await expect(
        router.link('/etc/config.txt', '/home/user/config.txt'),
      ).rejects.toSatisfy((err: unknown) => err instanceof FileSystemError && err.code === 'cross-device');
    });
  });

  describe('open/read routes to correct provider', () => {
    it('should read from sub-mount after open', async () => {
      const { DeviceFsProvider } = await import('./providers/device.ts');
      const devRouter = new FileSystemRouter();
      await devRouter.mount('/', new MemoryFsProvider());
      await devRouter.mount('/dev', new DeviceFsProvider());

      const handle = await devRouter.open('/dev/zero', { read: true });
      expect(handle.path).toBe('/dev/zero');
      const data = await devRouter.read(handle, 0, 4);
      expect(data.length).toBe(4);
      expect(data).toEqual(new Uint8Array([0, 0, 0, 0]));
      await devRouter.close(handle);
    });

    it('should read from root mount', async () => {
      const rootFs = new MemoryFsProvider();
      const rootHandle = rootFs.open('test.txt', { create: true, write: true });
      rootFs.write(rootHandle, new TextEncoder().encode('hello'), 0);
      rootFs.close(rootHandle);

      const testRouter = new FileSystemRouter();
      await testRouter.mount('/', rootFs);

      const handle = await testRouter.open('/test.txt', { read: true });
      const data = await testRouter.read(handle, 0, 5);
      expect(new TextDecoder().decode(data)).toBe('hello');
      await testRouter.close(handle);
    });
  });

  describe('exists', () => {
    it('should return true for existing file', async () => {
      const result = await router.exists('/home/user/file.txt');
      expect(result).toBe(true);
    });

    it('should return false for non-existing file', async () => {
      const result = await router.exists('/home/user/nope.txt');
      expect(result).toBe(false);
    });
  });

  describe('readdir includes mount points', () => {
    it('readdir / includes mount point entries', async () => {
      const { DeviceFsProvider } = await import('./providers/device.ts');
      const r = new FileSystemRouter();
      const memFs = new MemoryFsProvider();
      memFs.mkdir('/home');
      await r.mount('/', memFs);
      await r.mount('/dev', new DeviceFsProvider());

      const entries = await r.readdir('/');
      const names = entries.map(e => e.name);
      expect(names).toContain('home');
      expect(names).toContain('dev');
    });

    it('readdir / does not duplicate entries that exist in both provider and mounts', async () => {
      const { DeviceFsProvider } = await import('./providers/device.ts');
      const r = new FileSystemRouter();
      const memFs = new MemoryFsProvider();
      memFs.mkdir('/dev');
      await r.mount('/', memFs);
      await r.mount('/dev', new DeviceFsProvider());

      const entries = await r.readdir('/');
      const devEntries = entries.filter(e => e.name === 'dev');
      expect(devEntries.length).toBe(1);
    });

    it('readdir /tmp does not inject top-level mounts', async () => {
      const { DeviceFsProvider } = await import('./providers/device.ts');
      const r = new FileSystemRouter();
      const memFs = new MemoryFsProvider();
      memFs.mkdir('/tmp');
      await r.mount('/', memFs);
      await r.mount('/dev', new DeviceFsProvider());

      const entries = await r.readdir('/tmp');
      const names = entries.map(e => e.name);
      expect(names).not.toContain('dev');
    });

    it('nested mount appears in parent readdir', async () => {
      const r = new FileSystemRouter();
      const memFs = new MemoryFsProvider();
      memFs.mkdir('/mnt');
      await r.mount('/', memFs);
      await r.mount('/mnt/usb', new MemoryFsProvider());

      const entries = await r.readdir('/mnt');
      const names = entries.map(e => e.name);
      expect(names).toContain('usb');
    });
  });
});

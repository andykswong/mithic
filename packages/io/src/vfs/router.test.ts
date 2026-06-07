import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { FileSystemRouter } from './router.ts';
import { FileSystemError } from './provider.ts';
import { MemoryFsProvider } from './providers/memory.ts';

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
      assert.strictEqual(result.provider, rootProvider);
      assert.strictEqual(result.relativePath, 'etc/config.txt');
      assert.strictEqual(result.mountPoint, '/');
    });

    it('should resolve longest prefix mount', () => {
      const result = router.resolve('/home/user/file.txt');
      assert.strictEqual(result.provider, homeProvider);
      assert.strictEqual(result.relativePath, 'user/file.txt');
      assert.strictEqual(result.mountPoint, '/home');
    });

    it('should resolve root path to root mount', () => {
      const result = router.resolve('/');
      assert.strictEqual(result.provider, rootProvider);
      assert.strictEqual(result.relativePath, '/');
      assert.strictEqual(result.mountPoint, '/');
    });

    it('should resolve mount point itself', () => {
      const result = router.resolve('/home');
      assert.strictEqual(result.provider, homeProvider);
      assert.strictEqual(result.relativePath, '/');
      assert.strictEqual(result.mountPoint, '/home');
    });
  });

  describe('path normalization', () => {
    it('should handle trailing slashes', () => {
      const result = router.resolve('/home/user/');
      assert.strictEqual(result.provider, homeProvider);
      assert.strictEqual(result.relativePath, 'user');
    });

    it('should handle double slashes', () => {
      const result = router.resolve('/home//user//file.txt');
      assert.strictEqual(result.provider, homeProvider);
      assert.strictEqual(result.relativePath, 'user/file.txt');
    });

    it('should resolve dot segments', () => {
      const result = router.resolve('/home/user/../user/./file.txt');
      assert.strictEqual(result.provider, homeProvider);
      assert.strictEqual(result.relativePath, 'user/file.txt');
    });
  });

  describe('no-entry error', () => {
    it('should throw no-entry when no mount matches', async () => {
      const emptyRouter = new FileSystemRouter();
      assert.throws(
        () => emptyRouter.resolve('/some/path'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry'
      );
    });
  });

  describe('cross-mount operations', () => {
    it('should throw cross-device error on rename across mounts', async () => {
      await assert.rejects(
        () => router.rename('/etc/config.txt', '/home/user/config.txt'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'cross-device'
      );
    });

    it('should throw cross-device error on link across mounts', async () => {
      await assert.rejects(
        () => router.link('/etc/config.txt', '/home/user/config.txt'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'cross-device'
      );
    });
  });

  describe('open/read routes to correct provider', () => {
    it('should read from sub-mount after open', async () => {
      const { DeviceFsProvider } = await import('./providers/device.ts');
      const devRouter = new FileSystemRouter();
      await devRouter.mount('/', new MemoryFsProvider());
      await devRouter.mount('/dev', new DeviceFsProvider());

      const handle = await devRouter.open('/dev/zero', { read: true });
      assert.strictEqual(handle.path, '/dev/zero');
      const data = await devRouter.read(handle, 0, 4);
      assert.strictEqual(data.length, 4);
      assert.deepStrictEqual(data, new Uint8Array([0, 0, 0, 0]));
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
      assert.strictEqual(new TextDecoder().decode(data), 'hello');
      await testRouter.close(handle);
    });
  });

  describe('exists', () => {
    it('should return true for existing file', async () => {
      const result = await router.exists('/home/user/file.txt');
      assert.strictEqual(result, true);
    });

    it('should return false for non-existing file', async () => {
      const result = await router.exists('/home/user/nope.txt');
      assert.strictEqual(result, false);
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
      assert(names.includes('home'), 'should include home from MemoryFs');
      assert(names.includes('dev'), 'should include dev mount point');
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
      assert.strictEqual(devEntries.length, 1, 'dev should appear exactly once');
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
      assert(!names.includes('dev'), 'dev should not appear in /tmp listing');
    });

    it('nested mount appears in parent readdir', async () => {
      const r = new FileSystemRouter();
      const memFs = new MemoryFsProvider();
      memFs.mkdir('/mnt');
      await r.mount('/', memFs);
      await r.mount('/mnt/usb', new MemoryFsProvider());

      const entries = await r.readdir('/mnt');
      const names = entries.map(e => e.name);
      assert(names.includes('usb'), 'should include nested mount point');
    });
  });
});

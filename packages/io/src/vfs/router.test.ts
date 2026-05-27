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
});

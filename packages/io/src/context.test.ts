import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { IoContext } from './context.ts';
import { FileSystemRouter, type FileSystemProvider } from './vfs/index.ts';
import { DisabledHttpClient } from './net/providers/disabled-http.ts';
import { DisabledSocketProvider } from './net/sockets.ts';

describe('IoContext', () => {
  describe('default construction', () => {
    it('should create a VFS router', () => {
      const ctx = new IoContext();
      assert.ok(ctx.vfs instanceof FileSystemRouter);
    });

    it('should default http to DisabledHttpClient', () => {
      const ctx = new IoContext();
      assert.ok(ctx.http instanceof DisabledHttpClient);
    });

    it('should default sockets to DisabledSocketProvider', () => {
      const ctx = new IoContext();
      assert.ok(ctx.sockets instanceof DisabledSocketProvider);
    });

    it('should default env to empty map', () => {
      const ctx = new IoContext();
      assert.strictEqual(ctx.env.size, 0);
    });

    it('should default args to empty array', () => {
      const ctx = new IoContext();
      assert.deepStrictEqual(ctx.args, []);
    });

    it('should default cwd to /', () => {
      const ctx = new IoContext();
      assert.strictEqual(ctx.cwd, '/');
    });
  });

  describe('construction with options', () => {
    it('should mount VFS providers at correct paths', () => {
      const mockProvider = createMockFileSystemProvider();
      const ctx = new IoContext({
        vfs: { '/tmp': mockProvider },
      });

      const resolved = ctx.vfs.resolve('/tmp/file.txt');
      assert.ok(resolved);
      assert.strictEqual(resolved.provider, mockProvider);
      assert.strictEqual(resolved.relativePath, 'file.txt');
    });

    it('should set env from options', () => {
      const ctx = new IoContext({
        env: { HOME: '/home/user', PATH: '/usr/bin' },
      });
      assert.strictEqual(ctx.env.get('HOME'), '/home/user');
      assert.strictEqual(ctx.env.get('PATH'), '/usr/bin');
      assert.strictEqual(ctx.env.size, 2);
    });

    it('should set args from options', () => {
      const ctx = new IoContext({
        args: ['--verbose', 'input.txt'],
      });
      assert.deepStrictEqual(ctx.args, ['--verbose', 'input.txt']);
    });

    it('should set cwd from options', () => {
      const ctx = new IoContext({ cwd: '/home/user' });
      assert.strictEqual(ctx.cwd, '/home/user');
    });
  });

  describe('fork()', () => {
    it('should share the same VFS router reference', () => {
      const ctx = new IoContext();
      const child = ctx.fork();
      assert.strictEqual(child.vfs, ctx.vfs);
    });

    it('should have its own env', () => {
      const ctx = new IoContext({ env: { FOO: 'bar' } });
      const child = ctx.fork({ env: { BAZ: 'qux' } });
      assert.strictEqual(child.env.get('BAZ'), 'qux');
      assert.strictEqual(child.env.has('FOO'), false);
    });

    it('should inherit env when not overridden', () => {
      const ctx = new IoContext({ env: { FOO: 'bar' } });
      const child = ctx.fork();
      assert.strictEqual(child.env.get('FOO'), 'bar');
    });

    it('should have its own cwd', () => {
      const ctx = new IoContext({ cwd: '/root' });
      const child = ctx.fork({ cwd: '/home' });
      assert.strictEqual(child.cwd, '/home');
      assert.strictEqual(ctx.cwd, '/root');
    });

    it('should inherit cwd when not overridden', () => {
      const ctx = new IoContext({ cwd: '/root' });
      const child = ctx.fork();
      assert.strictEqual(child.cwd, '/root');
    });
  });

  describe('dispose()', () => {
    it('should call dispose on http provider', async () => {
      const httpDispose = mock.fn<() => void>();
      const ctx = new IoContext({
        http: { send: async () => ({ status: 200, headers: [] }), dispose: httpDispose },
      });
      await ctx.dispose();
      assert.strictEqual(httpDispose.mock.callCount(), 1);
    });

    it('should call dispose on sockets provider', async () => {
      const socketsDispose = mock.fn<() => void>();
      const ctx = new IoContext({
        sockets: {
          createTcpSocket: async () => { throw new Error('not impl'); },
          createUdpSocket: async () => { throw new Error('not impl'); },
          resolveName: async () => [],
          dispose: socketsDispose,
        },
      });
      await ctx.dispose();
      assert.strictEqual(socketsDispose.mock.callCount(), 1);
    });

    it('should call dispose on VFS providers', async () => {
      const providerDispose = mock.fn<() => Promise<void>>();
      providerDispose.mock.mockImplementation(async () => {});
      const mockProvider = createMockFileSystemProvider();
      mockProvider.dispose = providerDispose;

      const ctx = new IoContext({
        vfs: { '/mnt': mockProvider },
      });
      await ctx.dispose();
      assert.strictEqual(providerDispose.mock.callCount(), 1);
    });
  });

  describe('custom env/args/cwd', () => {
    it('should store custom env correctly', () => {
      const ctx = new IoContext({
        env: { NODE_ENV: 'production', DEBUG: 'true', LANG: 'en_US.UTF-8' },
      });
      assert.strictEqual(ctx.env.get('NODE_ENV'), 'production');
      assert.strictEqual(ctx.env.get('DEBUG'), 'true');
      assert.strictEqual(ctx.env.get('LANG'), 'en_US.UTF-8');
      assert.strictEqual(ctx.env.size, 3);
    });

    it('should store custom args correctly', () => {
      const ctx = new IoContext({
        args: ['--port', '8080', '--config', '/etc/app.json'],
      });
      assert.deepStrictEqual(ctx.args, ['--port', '8080', '--config', '/etc/app.json']);
    });

    it('should store custom cwd correctly', () => {
      const ctx = new IoContext({ cwd: '/home/user/project' });
      assert.strictEqual(ctx.cwd, '/home/user/project');
    });
  });

  describe('fork() with overridden env', () => {
    it('should have new env but same vfs', () => {
      const mockProvider = createMockFileSystemProvider();
      const ctx = new IoContext({
        vfs: { '/data': mockProvider },
        env: { FOO: 'bar', BAZ: 'qux' },
      });

      const child = ctx.fork({ env: { OVERRIDE: 'yes' } });

      // Child has new env
      assert.strictEqual(child.env.get('OVERRIDE'), 'yes');
      assert.strictEqual(child.env.has('FOO'), false);
      assert.strictEqual(child.env.has('BAZ'), false);
      assert.strictEqual(child.env.size, 1);

      // Same VFS router reference
      assert.strictEqual(child.vfs, ctx.vfs);
    });
  });

  describe('fork() preserves original cwd when not overridden', () => {
    it('should inherit cwd from parent', () => {
      const ctx = new IoContext({ cwd: '/workspace/project' });
      const child = ctx.fork({ env: { NEW_VAR: 'value' } });
      assert.strictEqual(child.cwd, '/workspace/project');
    });

    it('should not affect parent when child cwd is changed', () => {
      const ctx = new IoContext({ cwd: '/original' });
      const child = ctx.fork();
      child.cwd = '/modified';
      assert.strictEqual(ctx.cwd, '/original');
      assert.strictEqual(child.cwd, '/modified');
    });
  });
});

function createMockFileSystemProvider(): FileSystemProvider {
  return {
    async open(path, flags) { return { fd: 0, path, flags }; },
    async close() {},
    async read() { return new Uint8Array(); },
    async write(_handle, data) { return data.length; },
    async truncate() {},
    async stat() {
      const now = new Date();
      return { type: 'file', size: 0n, mode: 0o644, mtime: now, atime: now, ctime: now, linkCount: 1n };
    },
    async readdir() { return []; },
    async mkdir() {},
    async unlink() {},
    async rmdir() {},
    async rename() {},
    async symlink() {},
    async readlink() { return ''; },
    async link() {},
    async chmod() {},
    async utimes() {},
  };
}

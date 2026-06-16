import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { SyscallDispatcher } from './syscall-dispatch.ts';
import { CapabilityManager } from './capability-manager.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider, type FileSystemProvider } from '@mithic/io/vfs';

test('kernel spawns a worker process that writes to stdout and exits 0', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      await w.write(new TextEncoder().encode('hello\\n'));
      await w.close();
      g.exit(0);
    };`;
  const { pid, stdout } = await kernel.spawn(code, { args: ['prog'], capabilities: [], captureStdout: true });
  const code0 = await kernel.wait(pid);
  expect(code0.code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toContain('hello');
}, 15000);

// Fix 2: fs/read buffer-view transfer must not corrupt subarray views
test('fs/read with a subarray view delivers the correct bytes', async () => {
  // Build a VFS provider whose read() returns a subarray (view into a larger buffer).
  const bigBuffer = new Uint8Array(1024);
  bigBuffer.set(new TextEncoder().encode('world'), 100); // payload starts at offset 100
  const viewBytes = bigBuffer.subarray(100, 105); // "world" — byteOffset=100, byteLength=5

  // Minimal FileSystemProvider stub that always returns the view on read().
  const stubVfs = {
    async open() { return {}; },
    async read() { return viewBytes; },
    async write() { return 0; },
    async close() {},
    async stat() { return { type: 'file', size: 5n, mtime: 0n, linkCount: 0n }; },
    async readdir() { return []; },
    async mkdir() {},
    async unlink() {},
    async rename() {},
    async symlink() {},
    async readlink() {},
    resolve(p: string) { return { provider: stubVfs as unknown as FileSystemProvider, path: p }; },
  };

  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'fs', paths: ['/'], operations: ['read'] }]);
  const d = new SyscallDispatcher({ vfs: stubVfs as unknown as FileSystemProvider, caps, cwdOf: () => '/' });

  const open = (await d.dispatch(1, { id: 1, call: 'fs/open', args: { dirfd: -100, path: '/file', oflags: { read: true } } })).response;
  expect(open.ok).toBe(true);
  const fd = (open as { ok: true; result: { fd: number } }).result.fd;

  const readRes = (await d.dispatch(1, { id: 2, call: 'fs/read', args: { fd, len: 5 } })).response;
  expect(readRes.ok).toBe(true);
  const result = (readRes as { ok: true; result: Uint8Array }).result;
  expect(new TextDecoder().decode(result)).toBe('world');

  // The returned buffer must be a tight allocation (byteOffset === 0) so it
  // transfers correctly without leaking the surrounding pool bytes.
  expect(result.byteOffset).toBe(0);
  expect(result.byteLength).toBe(result.buffer.byteLength);
});

import { expect, test } from 'vitest';
import { SyscallDispatcher } from './syscall-dispatch.ts';
import { CapabilityManager } from './capability-manager.ts';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

async function setup() {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider({ files: { '/tmp/a.txt': 'hello' } }));
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }]);
  return new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/' });
}

test('fs/open + fs/read returns file bytes for an authorized process', async () => {
  const d = await setup();
  const open = await d.dispatch(1, { id: 1, call: 'fs/open', args: { dirfd: -100, path: '/tmp/a.txt', oflags: { read: true } } });
  expect(open.ok).toBe(true);
  const fd = (open as { ok: true; result: { fd: number } }).result.fd;
  const read = await d.dispatch(1, { id: 2, call: 'fs/read', args: { fd, len: 5 } });
  expect(new TextDecoder().decode((read as { ok: true; result: Uint8Array }).result)).toBe('hello');
});

test('fs/open outside granted prefix returns EACCES', async () => {
  const d = await setup();
  const res = await d.dispatch(1, { id: 3, call: 'fs/open', args: { dirfd: -100, path: '/etc/shadow', oflags: { read: true } } });
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
});

test('unknown syscall returns ENOSYS', async () => {
  const d = await setup();
  const res = await d.dispatch(1, { id: 4, call: 'bogus/call', args: {} });
  expect(res).toMatchObject({ ok: false, error: { code: 'ENOSYS' } });
});

// Fix 4: fd isolation — a process cannot use an fd opened by a different process
test('fd isolation: process 2 cannot read an fd opened by process 1 (EBADF)', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider({ files: { '/tmp/a.txt': 'hello' } }));
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  caps.grant(2, [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/' });

  // pid 1 opens the file
  const open = await d.dispatch(1, { id: 1, call: 'fs/open', args: { dirfd: -100, path: '/tmp/a.txt', oflags: { read: true } } });
  expect(open.ok).toBe(true);
  const fd = (open as { ok: true; result: { fd: number } }).result.fd;

  // pid 2 attempts to read that same fd number — must get EBADF
  const read = await d.dispatch(2, { id: 2, call: 'fs/read', args: { fd, len: 5 } });
  expect(read).toMatchObject({ ok: false, error: { code: 'EBADF' } });
});

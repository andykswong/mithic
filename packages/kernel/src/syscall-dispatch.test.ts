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

import { expect, test } from 'vitest';
import { SyscallDispatcher } from './syscall-dispatch.ts';
import { CapabilityManager } from './capability-manager.ts';
import { IpcBroker } from './ipc-broker.ts';
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
  const open = (await d.dispatch(1, { id: 1, call: 'fs/open', args: { dirfd: -100, path: '/tmp/a.txt', oflags: { read: true } } })).response;
  expect(open.ok).toBe(true);
  const fd = (open as { ok: true; result: { fd: number } }).result.fd;
  const read = (await d.dispatch(1, { id: 2, call: 'fs/read', args: { fd, len: 5 } })).response;
  expect(new TextDecoder().decode((read as { ok: true; result: Uint8Array }).result)).toBe('hello');
});

test('fs/open outside granted prefix returns EACCES', async () => {
  const d = await setup();
  const res = (await d.dispatch(1, { id: 3, call: 'fs/open', args: { dirfd: -100, path: '/etc/shadow', oflags: { read: true } } })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
});

test('unknown syscall returns ENOSYS', async () => {
  const d = await setup();
  const res = (await d.dispatch(1, { id: 4, call: 'bogus/call', args: {} })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'ENOSYS' } });
});

test('fs/pipe mints a pipe, returns readfd+writefd, and transfers both ports', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  const caps = new CapabilityManager();
  const ipc = new IpcBroker();
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', ipc });

  const { response, transfer } = await d.dispatch(1, { id: 1, call: 'fs/pipe', args: {} });
  expect(response.ok).toBe(true);
  const result = (response as { ok: true; result: { readfd: number; writefd: number } }).result;
  expect(typeof result.readfd).toBe('number');
  expect(typeof result.writefd).toBe('number');
  expect(result.readfd).not.toBe(result.writefd);
  // Both pipe ends must be transferred to the guest's realm.
  expect(transfer).toHaveLength(2);
  for (const p of transfer!) expect(p).toBeInstanceOf(MessagePort);

  // Data written into writePort must arrive on readPort (it's one channel).
  const [readPort, writePort] = transfer as MessagePort[];
  const got = new Promise<unknown>((resolve) => { readPort.onmessage = (e) => resolve(e.data); readPort.start?.(); });
  writePort.postMessage('ping');
  expect(await got).toBe('ping');
  readPort.close(); writePort.close();
});

test('fs/pipe without an IPC broker returns ENOSYS', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  const d = new SyscallDispatcher({ vfs: router, caps: new CapabilityManager(), cwdOf: () => '/' });
  const res = (await d.dispatch(1, { id: 1, call: 'fs/pipe', args: {} })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'ENOSYS' } });
});

test('read/write against a pipe fd is rejected with EBADF (serviced over the port)', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  const ipc = new IpcBroker();
  const d = new SyscallDispatcher({ vfs: router, caps: new CapabilityManager(), cwdOf: () => '/', ipc });
  const { response } = await d.dispatch(1, { id: 1, call: 'fs/pipe', args: {} });
  const { readfd } = (response as { ok: true; result: { readfd: number } }).result;
  const read = (await d.dispatch(1, { id: 2, call: 'fs/read', args: { fd: readfd, len: 4 } })).response;
  expect(read).toMatchObject({ ok: false, error: { code: 'EBADF' } });
  // fs/close on a pipe fd succeeds (kernel just forgets it; guest owns the port).
  const close = (await d.dispatch(1, { id: 3, call: 'fs/close', args: { fd: readfd } })).response;
  expect(close.ok).toBe(true);
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
  const open = (await d.dispatch(1, { id: 1, call: 'fs/open', args: { dirfd: -100, path: '/tmp/a.txt', oflags: { read: true } } })).response;
  expect(open.ok).toBe(true);
  const fd = (open as { ok: true; result: { fd: number } }).result.fd;

  // pid 2 attempts to read that same fd number — must get EBADF
  const read = (await d.dispatch(2, { id: 2, call: 'fs/read', args: { fd, len: 5 } })).response;
  expect(read).toMatchObject({ ok: false, error: { code: 'EBADF' } });
});

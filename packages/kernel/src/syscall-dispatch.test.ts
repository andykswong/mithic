import { expect, test } from 'vitest';
import { SyscallDispatcher } from './syscall-dispatch.ts';
import type { SpawnChild, WaitChild } from './syscall-dispatch.ts';
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

// ── process/* syscalls ────────────────────────────────────────────────────

function processSetup(opts: {
  parentCaps?: Parameters<CapabilityManager['grant']>[1];
  resolveCommand?: (name: string) => string | URL | undefined;
  spawnChild?: SpawnChild;
  waitChild?: WaitChild;
} = {}) {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, opts.parentCaps ?? [{ type: 'process' }]);
  const calls: Array<{ parentPid: number; code: string | URL; args: unknown; injected: Map<number, MessagePort> }> = [];
  const spawnChild: SpawnChild =
    opts.spawnChild ??
    (async (parentPid, code, args, injected) => {
      calls.push({ parentPid, code, args, injected });
      return { pid: 42 };
    });
  const d = new SyscallDispatcher({
    vfs: router,
    caps,
    cwdOf: () => '/home',
    resolveCommand: opts.resolveCommand ?? ((name) => (name === 'cat' ? 'CAT_CODE' : undefined)),
    spawnChild,
    waitChild: opts.waitChild ?? (async (pid) => ({ pid, status: 'exited', code: 0 })),
    ppidOf: () => 1,
  });
  return { d, caps, calls };
}

test('process/spawn resolves a registered command and spawns a child', async () => {
  const { d, calls } = processSetup();
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'cat', argv: ['cat', 'a.txt'] },
  })).response;
  expect(res).toMatchObject({ ok: true, result: { pid: 42 } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ parentPid: 1, code: 'CAT_CODE' });
});

test('process/spawn without a process capability returns EPERM', async () => {
  const { d } = processSetup({ parentCaps: [{ type: 'fs', paths: ['/'], operations: ['read'] }] });
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'cat', argv: ['cat'] },
  })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EPERM' } });
});

test('process/spawn of an unresolved command name returns ENOENT', async () => {
  const { d } = processSetup();
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'nope', argv: ['nope'] },
  })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
});

test('process/spawn passes an absolute path / URL straight through (no resolver)', async () => {
  const { d, calls } = processSetup({ resolveCommand: () => undefined });
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'https://example.com/cmd.js', argv: ['cmd'] },
  })).response;
  expect(res.ok).toBe(true);
  expect(calls[0].code).toBeInstanceOf(URL);
  expect(String(calls[0].code)).toBe('https://example.com/cmd.js');
});

test('process/spawn forwards pipe ports in the transfer list', async () => {
  const chan = new MessageChannel();
  const { d } = processSetup({
    spawnChild: async () => ({ pid: 7, pipes: { 1: 'transferred' }, transfer: [chan.port1] }),
  });
  const { response, transfer } = await d.dispatch(1, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'cat', argv: ['cat'], fds: { 1: { action: 'pipe' } } },
  });
  expect(response).toMatchObject({ ok: true, result: { pid: 7, pipes: { 1: 'transferred' } } });
  expect(transfer).toEqual([chan.port1]);
  chan.port1.close(); chan.port2.close();
});

test('process/wait delegates to waitChild for an owned child', async () => {
  const { d } = processSetup({ waitChild: async (pid) => ({ pid, status: 'exited', code: 3 }) });
  const res = (await d.dispatch(1, { id: 1, call: 'process/wait', args: { pid: 42 } })).response;
  expect(res).toMatchObject({ ok: true, result: { pid: 42, status: 'exited', code: 3 } });
});

test('process/wait on a non-child returns the no-child sentinel (ECHILD-style)', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'process' }]);
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    spawnChild: async () => ({ pid: 99 }),
    waitChild: async (pid) => ({ pid, status: 'exited', code: 0 }),
    // pid 99's parent is 1; pid 5 belongs to someone else (ppid 2).
    ppidOf: (pid) => (pid === 99 ? 1 : 2),
  });
  const res = (await d.dispatch(1, { id: 1, call: 'process/wait', args: { pid: 5 } })).response;
  expect(res).toMatchObject({ ok: true, result: { status: 'no-child', code: -1 } });
});

test('process/getpid / getppid / getcwd', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/work', ppidOf: () => 4 });
  expect((await d.dispatch(9, { id: 1, call: 'process/getpid', args: {} })).response)
    .toMatchObject({ ok: true, result: { pid: 9 } });
  expect((await d.dispatch(9, { id: 2, call: 'process/getppid', args: {} })).response)
    .toMatchObject({ ok: true, result: { ppid: 4 } });
  expect((await d.dispatch(9, { id: 3, call: 'process/getcwd', args: {} })).response)
    .toMatchObject({ ok: true, result: { cwd: '/work' } });
});

test('process/chdir updates the cwd via the chdir callback', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  let stored = '/';
  const d = new SyscallDispatcher({
    vfs: router, caps,
    cwdOf: () => stored,
    chdir: (_pid, path) => { stored = path; },
  });
  const res = (await d.dispatch(1, { id: 1, call: 'process/chdir', args: { path: '/tmp' } })).response;
  expect(res).toMatchObject({ ok: true, result: { cwd: '/tmp' } });
  expect(stored).toBe('/tmp');
});

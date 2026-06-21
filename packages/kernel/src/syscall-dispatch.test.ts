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

// ── extended fs/* syscalls (rmdir, rename, symlink, readlink, link, chmod, utimes, realpath) ──

async function fsSetup() {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider({ files: { '/tmp/a.txt': 'hello' } }));
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }]);
  return { d: new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/' }), router };
}

test('fs/mkdir + fs/rmdir round-trips an empty directory', async () => {
  const { d } = await fsSetup();
  const mk = (await d.dispatch(1, { id: 1, call: 'fs/mkdir', args: { path: '/tmp/d' } })).response;
  expect(mk.ok).toBe(true);
  const rm = (await d.dispatch(1, { id: 2, call: 'fs/rmdir', args: { path: '/tmp/d' } })).response;
  expect(rm.ok).toBe(true);
  const stat = (await d.dispatch(1, { id: 3, call: 'fs/stat', args: { path: '/tmp/d' } })).response;
  expect(stat).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
});

test('fs/rename moves a file within a granted prefix', async () => {
  const { d } = await fsSetup();
  const res = (await d.dispatch(1, { id: 1, call: 'fs/rename', args: { path: '/tmp/a.txt', newPath: '/tmp/b.txt' } })).response;
  expect(res.ok).toBe(true);
  const old = (await d.dispatch(1, { id: 2, call: 'fs/stat', args: { path: '/tmp/a.txt' } })).response;
  expect(old).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
  const moved = (await d.dispatch(1, { id: 3, call: 'fs/stat', args: { path: '/tmp/b.txt' } })).response;
  expect(moved.ok).toBe(true);
});

test('fs/rename into an ungranted prefix returns EACCES', async () => {
  const { d } = await fsSetup();
  const res = (await d.dispatch(1, { id: 1, call: 'fs/rename', args: { path: '/tmp/a.txt', newPath: '/etc/b.txt' } })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
});

test('fs/symlink + fs/readlink + lstat (followSymlinks:false)', async () => {
  const { d } = await fsSetup();
  const ln = (await d.dispatch(1, { id: 1, call: 'fs/symlink', args: { target: '/tmp/a.txt', path: '/tmp/l' } })).response;
  expect(ln.ok).toBe(true);
  const rl = (await d.dispatch(1, { id: 2, call: 'fs/readlink', args: { path: '/tmp/l' } })).response;
  expect((rl as { ok: true; result: { target: string } }).result.target).toBe('/tmp/a.txt');
  const lstat = (await d.dispatch(1, { id: 3, call: 'fs/stat', args: { path: '/tmp/l', followSymlinks: false } })).response;
  expect((lstat as { ok: true; result: { type: string } }).result.type).toBe('symlink');
  const stat = (await d.dispatch(1, { id: 4, call: 'fs/stat', args: { path: '/tmp/l' } })).response;
  expect((stat as { ok: true; result: { type: string } }).result.type).toBe('file');
});

test('fs/link creates a hard link to an existing file', async () => {
  const { d } = await fsSetup();
  const res = (await d.dispatch(1, { id: 1, call: 'fs/link', args: { target: '/tmp/a.txt', path: '/tmp/h.txt' } })).response;
  expect(res.ok).toBe(true);
  const stat = (await d.dispatch(1, { id: 2, call: 'fs/stat', args: { path: '/tmp/h.txt' } })).response;
  expect((stat as { ok: true; result: { size: number } }).result.size).toBe(5);
});

test('fs/chmod changes the mode reported by fs/stat', async () => {
  const { d } = await fsSetup();
  const res = (await d.dispatch(1, { id: 1, call: 'fs/chmod', args: { path: '/tmp/a.txt', mode: 0o600 } })).response;
  expect(res.ok).toBe(true);
  const stat = (await d.dispatch(1, { id: 2, call: 'fs/stat', args: { path: '/tmp/a.txt' } })).response;
  expect((stat as { ok: true; result: { mode: number } }).result.mode).toBe(0o600);
});

test('fs/utimes sets mtime (epoch ms)', async () => {
  const { d } = await fsSetup();
  const when = Date.UTC(2020, 0, 1);
  const res = (await d.dispatch(1, { id: 1, call: 'fs/utimes', args: { path: '/tmp/a.txt', atime: when, mtime: when } })).response;
  expect(res.ok).toBe(true);
  const stat = (await d.dispatch(1, { id: 2, call: 'fs/stat', args: { path: '/tmp/a.txt' } })).response;
  expect(new Date((stat as { ok: true; result: { mtime: Date } }).result.mtime).getTime()).toBe(when);
});

test('fs/realpath canonicalizes through a symlink', async () => {
  const { d } = await fsSetup();
  await d.dispatch(1, { id: 1, call: 'fs/symlink', args: { target: '/tmp/a.txt', path: '/tmp/l' } });
  const res = (await d.dispatch(1, { id: 2, call: 'fs/realpath', args: { path: '/tmp/l' } })).response;
  expect((res as { ok: true; result: { path: string } }).result.path).toBe('/tmp/a.txt');
});

test('fs/chmod outside a granted prefix returns EACCES', async () => {
  const { d } = await fsSetup();
  const res = (await d.dispatch(1, { id: 1, call: 'fs/chmod', args: { path: '/etc/x', mode: 0o600 } })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
});

// ── SEC-2: symlink escape past the fs capability prefix ─────────────────────

/**
 * Build a dispatcher whose VFS contains a granted `/work` prefix and an
 * ungranted `/etc` prefix, with a symlink `/work/escape` → `/etc/passwd`
 * planted INSIDE the grant pointing OUTSIDE it. The process holds rw on `/work`
 * only. The capability check must canonicalize through the symlink and DENY
 * access to the escaped (ungranted) target.
 */
async function symlinkEscapeSetup() {
  const router = new FileSystemRouter();
  const provider = new MemoryFsProvider({
    files: {
      '/work/inside.txt': 'inside-data',
      '/etc/passwd': 'root:x:0:0:SECRET',
    },
  });
  await router.mount('/', provider);
  // The symlink lives inside the grant but targets outside it.
  await provider.symlink('/etc/passwd', '/work/escape');
  // A legitimate in-prefix symlink: /work/legit → /work/inside.txt
  await provider.symlink('/work/inside.txt', '/work/legit');
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'fs', paths: ['/work'], operations: ['read', 'write'] }]);
  return new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/' });
}

test('SEC-2: fs/open of an in-grant symlink that escapes the prefix is EACCES', async () => {
  const d = await symlinkEscapeSetup();
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'fs/open',
    args: { dirfd: -100, path: '/work/escape', oflags: { read: true } },
  })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
});

test('SEC-2: fs/stat (follow) of an escaping symlink is EACCES (no leak of target type/size)', async () => {
  const d = await symlinkEscapeSetup();
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'fs/stat',
    args: { path: '/work/escape' },
  })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
});

test('SEC-2: reading a fd opened via an escaping symlink never yields the target bytes', async () => {
  const d = await symlinkEscapeSetup();
  // Open must be denied; if it somehow opened, the bytes would be the secret.
  const open = (await d.dispatch(1, {
    id: 1,
    call: 'fs/open',
    args: { dirfd: -100, path: '/work/escape', oflags: { read: true } },
  })).response;
  expect(open.ok).toBe(false);
  expect((open as { ok: false; error: { code: string } }).error.code).toBe('EACCES');
});

test('SEC-2: a legitimate in-prefix symlink still resolves and opens', async () => {
  const d = await symlinkEscapeSetup();
  const open = (await d.dispatch(1, {
    id: 1,
    call: 'fs/open',
    args: { dirfd: -100, path: '/work/legit', oflags: { read: true } },
  })).response;
  expect(open.ok).toBe(true);
  const fd = (open as { ok: true; result: { fd: number } }).result.fd;
  const read = (await d.dispatch(1, { id: 2, call: 'fs/read', args: { fd, len: 11 } })).response;
  expect(new TextDecoder().decode((read as { ok: true; result: Uint8Array }).result)).toBe('inside-data');
});

test('SEC-2: lstat (followSymlinks:false) of the escaping link still works (inspects the link itself)', async () => {
  const d = await symlinkEscapeSetup();
  // lstat does NOT follow the final component, so it inspects /work/escape (the
  // link), which is inside the grant — this must be allowed and report 'symlink'.
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'fs/stat',
    args: { path: '/work/escape', followSymlinks: false },
  })).response;
  expect(res.ok).toBe(true);
  expect((res as { ok: true; result: { type: string } }).result.type).toBe('symlink');
});

test('SEC-2: readlink of the escaping link works (reads the link, does not follow it)', async () => {
  const d = await symlinkEscapeSetup();
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'fs/readlink',
    args: { path: '/work/escape' },
  })).response;
  expect(res.ok).toBe(true);
  expect((res as { ok: true; result: { target: string } }).result.target).toBe('/etc/passwd');
});

test('SEC-2: a symlink CYCLE does not hang — bounded resolution yields an error', async () => {
  const router = new FileSystemRouter();
  const provider = new MemoryFsProvider({ files: { '/work/.keep': '' } });
  await router.mount('/', provider);
  // /work/a → /work/b → /work/a (cycle, both inside the grant).
  await provider.symlink('/work/b', '/work/a');
  await provider.symlink('/work/a', '/work/b');
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'fs', paths: ['/work'], operations: ['read', 'write'] }]);
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/' });
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'fs/open',
    args: { dirfd: -100, path: '/work/a', oflags: { read: true } },
  })).response;
  // Must settle (no hang) with a clean error — ELOOP from the VFS realpath bound.
  expect(res.ok).toBe(false);
  expect(['ELOOP', 'ENOENT', 'EIO']).toContain((res as { ok: false; error: { code: string } }).error.code);
});

test('SEC-2: opening a NEW file (create) inside the grant is unaffected by canonicalization', async () => {
  const d = await symlinkEscapeSetup();
  // The path does not exist yet; realpath of a non-existent leaf must not block
  // a legitimate create inside the grant.
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'fs/open',
    args: { dirfd: -100, path: '/work/new.txt', oflags: { write: true, create: true } },
  })).response;
  expect(res.ok).toBe(true);
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

// D4: process/kill
test('process/kill delivers a signal to an OWN child (ppid match) and reports ok', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'process' }]);
  const kills: Array<{ pid: number; signal: string }> = [];
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    ppidOf: (pid) => (pid === 7 ? 1 : 0), // pid 7's parent is pid 1
    killChild: (pid, signal) => { kills.push({ pid, signal }); },
  });
  const res = (await d.dispatch(1, { id: 1, call: 'process/kill', args: { pid: 7, signal: 'SIGTERM' } })).response;
  expect(res).toMatchObject({ ok: true });
  expect(kills).toEqual([{ pid: 7, signal: 'SIGTERM' }]);
});

test('process/kill defaults to SIGTERM and SIG-prefixes a bare name', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  const kills: Array<{ pid: number; signal: string }> = [];
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    ppidOf: () => 1,
    killChild: (pid, signal) => { kills.push({ pid, signal }); },
  });
  await d.dispatch(1, { id: 1, call: 'process/kill', args: { pid: 7 } });
  await d.dispatch(1, { id: 2, call: 'process/kill', args: { pid: 7, signal: 'KILL' } });
  expect(kills).toEqual([{ pid: 7, signal: 'SIGTERM' }, { pid: 7, signal: 'SIGKILL' }]);
});

test('process/kill of a NON-child (ppid mismatch) returns EPERM and does not deliver', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  const kills: Array<{ pid: number; signal: string }> = [];
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    ppidOf: () => 999, // target's parent is NOT the caller (pid 1)
    killChild: (pid, signal) => { kills.push({ pid, signal }); },
  });
  const res = (await d.dispatch(1, { id: 1, call: 'process/kill', args: { pid: 7 } })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EPERM' } });
  expect(kills).toEqual([]);
});

test('process/kill without a kill handler returns ENOSYS', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', ppidOf: () => 1 });
  const res = (await d.dispatch(1, { id: 1, call: 'process/kill', args: { pid: 7 } })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'ENOSYS' } });
});

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

// ── Regression tests for process/spawn correctness fixes ────────────────────

/**
 * Fix 1 regression: a process with maxChildren:2 should be able to spawn again
 * after a child self-exits (without being waited), because closeProcess() now
 * removes the child from the parent's liveChildPids set on self-exit.
 * Previously, only process/wait shrank the live set, causing premature lockout.
 */
test('Fix 1: maxChildren slot freed when child self-exits without being waited', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  // Parent pid=1 with maxChildren:2.
  caps.grant(1, [{ type: 'process', maxChildren: 2 }]);

  // Track which children have been spawned so we can simulate self-exit.
  const spawnedPids: number[] = [];
  let nextChildPid = 100;

  const spawnChild: SpawnChild = async () => {
    const pid = nextChildPid++;
    spawnedPids.push(pid);
    return { pid };
  };

  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    resolveCommand: () => 'CMD',
    spawnChild,
    ppidOf: (pid) => (spawnedPids.includes(pid) ? 1 : 0),
  });

  // Spawn two children — fills maxChildren:2.
  const r1 = (await d.dispatch(1, { id: 1, call: 'process/spawn', args: { path: 'cmd', argv: ['cmd'] } })).response;
  expect(r1.ok).toBe(true);
  const r2 = (await d.dispatch(1, { id: 2, call: 'process/spawn', args: { path: 'cmd', argv: ['cmd'] } })).response;
  expect(r2.ok).toBe(true);

  // Third spawn must fail: limit reached.
  const r3 = (await d.dispatch(1, { id: 3, call: 'process/spawn', args: { path: 'cmd', argv: ['cmd'] } })).response;
  expect(r3).toMatchObject({ ok: false, error: { code: 'EPERM' } });

  // Simulate child 100 self-exiting (closeProcess called by the kernel's #exit).
  d.closeProcess(100);

  // Now a new spawn must SUCCEED — the slot was freed by the self-exit.
  const r4 = (await d.dispatch(1, { id: 4, call: 'process/spawn', args: { path: 'cmd', argv: ['cmd'] } })).response;
  expect(r4.ok).toBe(true);
});

/**
 * Fix 2 regression: on a non-transferable (relay) backend (directPipes:false),
 * process/spawn with a 'pipe' fd action must return ENOSYS WITHOUT creating a
 * child (no orphan). Verified by asserting the spawnChild callback is never called.
 */
test('Fix 2: relay backend process/spawn with pipe fd returns ENOSYS without spawning orphan', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'process' }]);

  let spawnCalled = false;
  const spawnChild: SpawnChild = async () => {
    spawnCalled = true;
    return { pid: 42 };
  };

  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    resolveCommand: () => 'CMD',
    spawnChild,
    directPipes: false, // relay backend: cannot transfer ports
  });

  const res = (await d.dispatch(1, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'cmd', argv: ['cmd'], fds: { 1: { action: 'pipe' } } },
  })).response;

  expect(res).toMatchObject({ ok: false, error: { code: 'ENOSYS' } });
  // The critical assertion: no child was created — spawnChild must not have been called.
  expect(spawnCalled).toBe(false);
});

/**
 * Fix 2 extra: relay backend without pipe fds still works (ENOSYS is specific
 * to pipe actions, not all spawns on relay backends).
 */
test('Fix 2: relay backend process/spawn without pipe fds succeeds', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'process' }]);

  const spawnChild: SpawnChild = async () => ({ pid: 42 });

  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    resolveCommand: () => 'CMD',
    spawnChild,
    directPipes: false,
  });

  // spawn without any pipe fds — should succeed.
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'cmd', argv: ['cmd'] },
  })).response;
  expect(res).toMatchObject({ ok: true, result: { pid: 42 } });
});

/**
 * Fix 3 regression: process/pipeline with more stages than remaining maxChildren
 * slots must be rejected (EPERM) without running any stages.
 * Previously, pipeline bypassed maxChildren by not passing currentChildren to
 * checkProcess, so a guest could spawn unlimited children via pipeline.
 */
test('Fix 3: process/pipeline with 3 stages rejected when maxChildren:2', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'process', maxChildren: 2 }]);

  let pipelineRan = false;
  const pipelineChild = async () => {
    pipelineRan = true;
    return { exitCodes: [], lastStdout: new Uint8Array() };
  };

  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    resolveCommand: (name) => name,
    pipelineChild,
  });

  const res = (await d.dispatch(1, {
    id: 1,
    call: 'process/pipeline',
    args: {
      stages: [
        { path: 'cmd1', argv: ['cmd1'] },
        { path: 'cmd2', argv: ['cmd2'] },
        { path: 'cmd3', argv: ['cmd3'] },
      ],
    },
  })).response;

  expect(res).toMatchObject({ ok: false, error: { code: 'EPERM' } });
  expect(pipelineRan).toBe(false);
});

/**
 * Fix 3 extra: a 2-stage pipeline with maxChildren:2 must still succeed.
 */
test('Fix 3: process/pipeline with 2 stages succeeds when maxChildren:2', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'process', maxChildren: 2 }]);

  const pipelineChild = async () => ({ exitCodes: [0, 0], lastStdout: new Uint8Array() });

  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    resolveCommand: (name) => name,
    pipelineChild,
  });

  const res = (await d.dispatch(1, {
    id: 1,
    call: 'process/pipeline',
    args: {
      stages: [
        { path: 'cmd1', argv: ['cmd1'] },
        { path: 'cmd2', argv: ['cmd2'] },
      ],
    },
  })).response;
  expect(res.ok).toBe(true);
});

// ── net/fetch syscall ──────────────────────────────────────────────────────

import type { HttpClient, HttpRequest, HttpResponse } from '@mithic/io/net';
import { bytesToStream } from '@mithic/io/net';

/** A scripted/recorded response authored with BYTES (B6: the wire body is a stream). */
interface NetResp { status: number; headers: [string, string][]; body?: Uint8Array }

/** A tiny recording HTTP client for dispatcher tests (no real network). Mints a
 * FRESH stream body per send (a stream is single-use). */
function recordingClient(response: NetResp): { client: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const client: HttpClient = {
    send(req: HttpRequest): HttpResponse {
      calls.push(req);
      const out: HttpResponse = { status: response.status, headers: response.headers };
      if (response.body !== undefined) out.body = bytesToStream(response.body);
      return out;
    },
  };
  return { client, calls };
}

function netSetup(opts: { caps?: Parameters<CapabilityManager['grant']>[1]; response?: NetResp } = {}) {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, opts.caps ?? [{ type: 'net', origins: ['https://api.example.com'] }]);
  const { client, calls } = recordingClient(
    opts.response ?? { status: 200, headers: [['content-type', 'text/plain']], body: new TextEncoder().encode('hi') },
  );
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', httpClient: client });
  return { d, calls };
}

test('net/fetch on a granted origin performs the request and returns status/headers/body', async () => {
  const { d, calls } = netSetup();
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'https://api.example.com/data', headers: [] },
  })).response;
  expect(res.ok).toBe(true);
  const result = (res as { ok: true; result: { status: number; headers: [string, string][]; body?: Uint8Array } }).result;
  expect(result.status).toBe(200);
  expect(result.headers).toEqual([['content-type', 'text/plain']]);
  expect(new TextDecoder().decode(result.body)).toBe('hi');
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.example.com/data');
  expect(calls[0].method).toBe('GET');
});

test('net/fetch to an origin NOT granted returns EACCES (capability gating)', async () => {
  const { d, calls } = netSetup();
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'https://evil.example.org/steal', headers: [] },
  })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
  // The HTTP client must NEVER be invoked for an ungranted origin.
  expect(calls).toHaveLength(0);
});

test('net/fetch with no http client configured returns ENOSYS', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://api.example.com'] }]);
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/' });
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'https://api.example.com/x', headers: [] },
  })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'ENOSYS' } });
});

test('net/fetch forwards method, headers, and body to the http client', async () => {
  const { d, calls } = netSetup();
  await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: {
      method: 'POST',
      url: 'https://api.example.com/post',
      headers: [['content-type', 'application/json']],
      body: new TextEncoder().encode('{"a":1}'),
    },
  });
  expect(calls[0].method).toBe('POST');
  expect(calls[0].headers).toEqual([['content-type', 'application/json']]);
  expect(new TextDecoder().decode(calls[0].body)).toBe('{"a":1}');
});

test('net/fetch maps an http client failure to a kernel error (EHOSTUNREACH)', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://api.example.com'] }]);
  const client: HttpClient = { send() { throw new Error('connection refused'); } };
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', httpClient: client });
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'https://api.example.com/x', headers: [] },
  })).response;
  expect(res.ok).toBe(false);
  expect((res as { ok: false; error: { code: string } }).error.code).toBe('EHOSTUNREACH');
});

test('net/fetch with an invalid url returns EACCES (no origin → no capability)', async () => {
  const { d, calls } = netSetup();
  const res = (await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'not a url', headers: [] },
  })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
  expect(calls).toHaveLength(0);
});

// ── SEC-1: SSRF via HTTP redirect — per-hop capability re-check ──────────────

/**
 * A scripted HTTP client that returns a queued sequence of responses, one per
 * `send()`. Records every request URL it was asked to fetch. Used to model a
 * server that 3xx-redirects to another origin.
 */
function scriptedClient(responses: NetResp[]): { client: HttpClient; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const client: HttpClient = {
    send(req: HttpRequest): HttpResponse {
      urls.push(req.url);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      const out: HttpResponse = { status: r.status, headers: r.headers };
      if (r.body !== undefined) out.body = bytesToStream(r.body);
      return out;
    },
  };
  return { client, urls };
}

test('SEC-1: net/fetch does NOT follow a 3xx redirect to an UNGRANTED origin — EACCES, no body leak', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  // Guest is granted ONLY origin A. The server at A redirects to evil origin B.
  caps.grant(1, [{ type: 'net', origins: ['https://a.example.com'] }]);
  const secret = new TextEncoder().encode('CLOUD-METADATA-SECRET');
  const { client, urls } = scriptedClient([
    { status: 302, headers: [['location', 'http://169.254.169.254/latest/meta-data/']], body: undefined },
    // This would be the metadata body — it must NEVER reach the guest.
    { status: 200, headers: [['content-type', 'text/plain']], body: secret },
  ]);
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', httpClient: client });

  const res = (await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'https://a.example.com/redir', headers: [] },
  })).response;

  // The redirect target is ungranted → the dispatcher must NOT follow it.
  expect(res).toMatchObject({ ok: false, error: { code: 'EACCES' } });
  // The HTTP client must have been asked ONLY for the granted origin, never the
  // metadata endpoint. No body from the ungranted origin ever fetched.
  expect(urls).toEqual(['https://a.example.com/redir']);
});

test('SEC-1: net/fetch FOLLOWS a 3xx redirect to an ALSO-GRANTED origin and returns its body', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://a.example.com', 'https://b.example.com'] }]);
  const finalBody = new TextEncoder().encode('OK-FROM-B');
  const { client, urls } = scriptedClient([
    { status: 302, headers: [['location', 'https://b.example.com/landing']], body: undefined },
    { status: 200, headers: [['content-type', 'text/plain']], body: finalBody },
  ]);
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', httpClient: client });

  const res = (await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'https://a.example.com/redir', headers: [] },
  })).response;

  expect(res.ok).toBe(true);
  const result = (res as { ok: true; result: { status: number; body?: Uint8Array } }).result;
  expect(result.status).toBe(200);
  expect(new TextDecoder().decode(result.body)).toBe('OK-FROM-B');
  // Both hops went through the client because both origins are granted.
  expect(urls).toEqual(['https://a.example.com/redir', 'https://b.example.com/landing']);
});

test('SEC-1: net/fetch caps redirect chains (ELOOP) instead of following forever', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://a.example.com'] }]);
  // Every response is a redirect back to a granted origin → infinite loop unless capped.
  const { client, urls } = scriptedClient([
    { status: 302, headers: [['location', 'https://a.example.com/again']], body: undefined },
  ]);
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', httpClient: client });

  const res = (await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'https://a.example.com/start', headers: [] },
  })).response;

  expect(res.ok).toBe(false);
  expect((res as { ok: false; error: { code: string } }).error.code).toBe('ELOOP');
  // It must have stopped after a bounded number of hops, not run away.
  expect(urls.length).toBeLessThanOrEqual(21);
  expect(urls.length).toBeGreaterThan(1);
});

test('SEC-1: net/fetch requests redirect:manual from the HTTP client (no internal following)', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://a.example.com'] }]);
  const seen: HttpRequest[] = [];
  const client: HttpClient = {
    send(req: HttpRequest): HttpResponse {
      seen.push(req);
      return { status: 200, headers: [], body: undefined };
    },
  };
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', httpClient: client });
  await d.dispatch(1, {
    id: 1,
    call: 'net/fetch',
    args: { method: 'GET', url: 'https://a.example.com/x', headers: [] },
  });
  // The dispatcher must instruct the client NOT to follow redirects itself, so
  // the kernel can capability-check each hop.
  expect(seen[0].redirect).toBe('manual');
});

// ── B6: streaming response body delivery ─────────────────────────────────────

import { portToReadable } from '@mithic/guest-runtime';

/** Drain a transferred read port (the streaming body) into one Uint8Array. */
async function drainPort(port: MessagePort): Promise<Uint8Array> {
  const reader = portToReadable(port).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

test('B6: on a transferable backend (ipc + directPipes) net/fetch streams the body over a transferred port', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://api.example.com'] }]);
  // A multi-chunk body emitted lazily through the kernel pump.
  const parts = ['alpha-', 'beta-', 'gamma'];
  const client: HttpClient = {
    send(): HttpResponse {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i >= parts.length) { controller.close(); return; }
          controller.enqueue(new TextEncoder().encode(parts[i]));
          i++;
        },
      });
      return { status: 200, headers: [['content-type', 'text/plain']], body };
    },
  };
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/', httpClient: client,
    ipc: new IpcBroker(), directPipes: true,
  });

  const { response, transfer } = await d.dispatch(1, {
    id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/big', headers: [] },
  });

  expect(response.ok).toBe(true);
  const result = (response as { ok: true; result: { status: number; bodyStream?: boolean; body?: Uint8Array } }).result;
  expect(result.status).toBe(200);
  // Streaming delivery: a flag + a transferred read port, NOT inline bytes.
  expect(result.bodyStream).toBe(true);
  expect(result.body).toBeUndefined();
  expect(transfer).toHaveLength(1);
  expect(transfer![0]).toBeInstanceOf(MessagePort);

  // Draining the transferred port yields the streamed bytes.
  const bytes = await drainPort(transfer![0] as MessagePort);
  expect(new TextDecoder().decode(bytes)).toBe('alpha-beta-gamma');
});

test('B6: cancelling the streamed-body port aborts the source stream (early stop)', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://api.example.com'] }]);
  let cancelled = false;
  let produced = 0;
  const client: HttpClient = {
    send(): HttpResponse {
      // An UNBOUNDED body: only the consumer cancelling stops it.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { produced++; controller.enqueue(new Uint8Array([produced & 0xff])); },
        cancel() { cancelled = true; },
      });
      return { status: 200, headers: [], body };
    },
  };
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/', httpClient: client,
    ipc: new IpcBroker(), directPipes: true,
  });

  const { transfer } = await d.dispatch(1, {
    id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/infinite', headers: [] },
  });
  const stream = portToReadable(transfer![0] as MessagePort);
  const reader = stream.getReader();
  await reader.read();             // pull one chunk
  await reader.cancel();           // consumer stops early → EPIPE up the port
  // The kernel pump observes the broken pipe and cancels the source stream.
  await new Promise((r) => setTimeout(r, 20));
  expect(cancelled).toBe(true);
});

test('B6: on a NON-transferable backend (no ipc) net/fetch buffers the body inline (fallback)', async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://api.example.com'] }]);
  const client: HttpClient = {
    send(): HttpResponse {
      return { status: 200, headers: [], body: bytesToStream(new TextEncoder().encode('buffered-bytes')) };
    },
  };
  // No ipc broker → directPipes can't transfer a body port → buffered fallback.
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', httpClient: client });

  const { response, transfer } = await d.dispatch(1, {
    id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/x', headers: [] },
  });
  expect(response.ok).toBe(true);
  const result = (response as { ok: true; result: { bodyStream?: boolean; body?: Uint8Array } }).result;
  // Buffered: inline bytes, no stream flag, no transferred port.
  expect(result.bodyStream).toBeUndefined();
  expect(transfer).toBeUndefined();
  expect(new TextDecoder().decode(result.body)).toBe('buffered-bytes');
});

/**
 * R2 (regression): a real HTTP `response.body` chunk can exceed the guest
 * reader's credit WINDOW (default 64 KiB via `portToReadable`). The kernel pump
 * (`#feedStreamToPort`) must NOT `reserve()` more than the window in one go —
 * otherwise `reserve()` parks forever (the reader can never grant more than its
 * window) and streaming fetch HANGS. The pump must chunk writes below the window
 * so any window works. Run through the REAL pump → transferred port →
 * `portToReadable`, with a tight timeout that fails (rather than hangs) on
 * regression.
 */
test('R2: net/fetch streams a body with a single chunk LARGER than the credit window without deadlocking', { timeout: 5000 }, async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://api.example.com'] }]);
  // A SINGLE 256 KiB chunk — 4x the default 64 KiB guest reader window. A pump
  // that reserves the whole chunk at once would park forever here.
  const big = new Uint8Array(256 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const client: HttpClient = {
    send(): HttpResponse {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) { controller.close(); return; }
          sent = true;
          controller.enqueue(big);
        },
      });
      return { status: 200, headers: [], body };
    },
  };
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/', httpClient: client,
    ipc: new IpcBroker(), directPipes: true,
  });

  const { response, transfer } = await d.dispatch(1, {
    id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/big', headers: [] },
  });
  expect(response.ok).toBe(true);
  expect((response as { ok: true; result: { bodyStream?: boolean } }).result.bodyStream).toBe(true);

  // Draining via the default-window reader yields the full 256 KiB intact.
  const bytes = await drainPort(transfer![0] as MessagePort);
  expect(bytes.byteLength).toBe(big.byteLength);
  expect(bytes).toEqual(big);
});

test('R2: net/fetch streams MULTIPLE over-window chunks back-to-back without deadlocking', { timeout: 5000 }, async () => {
  const router = new FileSystemRouter();
  const caps = new CapabilityManager();
  caps.grant(1, [{ type: 'net', origins: ['https://api.example.com'] }]);
  // Several 96 KiB chunks (each > the 64 KiB window).
  const chunkSize = 96 * 1024;
  const count = 5;
  const parts: Uint8Array[] = [];
  for (let c = 0; c < count; c++) {
    const part = new Uint8Array(chunkSize);
    for (let i = 0; i < part.length; i++) part[i] = (c * 7 + i) & 0xff;
    parts.push(part);
  }
  const client: HttpClient = {
    send(): HttpResponse {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i >= parts.length) { controller.close(); return; }
          controller.enqueue(parts[i]);
          i++;
        },
      });
      return { status: 200, headers: [], body };
    },
  };
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/', httpClient: client,
    ipc: new IpcBroker(), directPipes: true,
  });

  const { transfer } = await d.dispatch(1, {
    id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/big', headers: [] },
  });
  const bytes = await drainPort(transfer![0] as MessagePort);
  const expected = new Uint8Array(chunkSize * count);
  let off = 0;
  for (const p of parts) { expected.set(p, off); off += p.byteLength; }
  expect(bytes.byteLength).toBe(expected.byteLength);
  expect(bytes).toEqual(expected);
});

// --- C2: typed syscall union + handler map ---

test('C2: unknown call still returns ENOSYS', async () => {
  const d = await setup();
  const res = (await d.dispatch(1, { id: 99, call: 'totally/bogus', args: {} })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'ENOSYS' } });
});

test('C2: malformed fs/read args (non-numeric fd) is rejected with EINVAL, not a crash', async () => {
  const d = await setup();
  const res = (await d.dispatch(1, { id: 1, call: 'fs/read', args: { fd: 'not-a-number', len: 4 } })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EINVAL' } });
});

test('C2: malformed fs/open args (missing path) is rejected with EINVAL', async () => {
  const d = await setup();
  const res = (await d.dispatch(1, { id: 2, call: 'fs/open', args: { oflags: { read: true } } })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EINVAL' } });
});

test('C2: malformed process/wait args (missing pid) is rejected with EINVAL', async () => {
  const d = await setup();
  const res = (await d.dispatch(1, { id: 3, call: 'process/wait', args: {} })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EINVAL' } });
});

test('C2: pipe/read|write|close are first-class — EBADF on a transfer-path backend (no relay handler)', async () => {
  const d = await setup();
  const r1 = (await d.dispatch(1, { id: 1, call: 'pipe/read', args: { fd: 5 } })).response;
  const r2 = (await d.dispatch(1, { id: 2, call: 'pipe/write', args: { fd: 5, data: 'hi' } })).response;
  const r3 = (await d.dispatch(1, { id: 3, call: 'pipe/close', args: { fd: 5 } })).response;
  expect(r1).toMatchObject({ ok: false, error: { code: 'EBADF' } });
  expect(r2).toMatchObject({ ok: false, error: { code: 'EBADF' } });
  expect(r3).toMatchObject({ ok: false, error: { code: 'EBADF' } });
});

test('C2: injected relayPipe handlers service pipe/* through the dispatcher', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  const caps = new CapabilityManager();
  const calls: string[] = [];
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    relayPipe: {
      read: async (_pid, fd) => { calls.push(`read:${fd}`); return { ok: true, result: { data: [104, 105] } }; },
      write: async (_pid, fd, data) => { calls.push(`write:${fd}`); return { ok: true, result: { written: (data as string).length } }; },
      close: (_pid, fd) => { calls.push(`close:${fd}`); return { ok: true, result: {} }; },
    },
  });
  const read = (await d.dispatch(1, { id: 1, call: 'pipe/read', args: { fd: 3, len: 2 } })).response;
  expect(read).toMatchObject({ ok: true, result: { data: [104, 105] } });
  const write = (await d.dispatch(1, { id: 2, call: 'pipe/write', args: { fd: 4, data: 'hey' } })).response;
  expect(write).toMatchObject({ ok: true, result: { written: 3 } });
  const close = (await d.dispatch(1, { id: 3, call: 'pipe/close', args: { fd: 3 } })).response;
  expect(close).toMatchObject({ ok: true });
  expect(calls).toEqual(['read:3', 'write:4', 'close:3']);
});

test('C2: malformed pipe/write args (non-numeric fd) is rejected with EINVAL', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  const caps = new CapabilityManager();
  const d = new SyscallDispatcher({
    vfs: router, caps, cwdOf: () => '/',
    relayPipe: {
      read: async () => ({ ok: true, result: { data: [] } }),
      write: async () => ({ ok: true, result: { written: 0 } }),
      close: () => ({ ok: true, result: {} }),
    },
  });
  const res = (await d.dispatch(1, { id: 1, call: 'pipe/write', args: { fd: {}, data: 'x' } })).response;
  expect(res).toMatchObject({ ok: false, error: { code: 'EINVAL' } });
});

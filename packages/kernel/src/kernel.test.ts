import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import type { SpawnChildResult } from './syscall-dispatch.ts';
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

// ── K2: fd >= 3 port injection / pipe / open actions are now supported ──────
// (Superseded the old "Fix 4" EINVAL behavior: fd >= 3 was previously rejected;
//  K2 wires arbitrary preopen fds. Deeper coverage lives in kernel-fd-actions.test.ts.)

/**
 * K2: a process/spawn with a `pipe` fd action on fd 3 SUCCEEDS — the child gets a
 * preopen pipe at fd 3 and the parent-facing end is transferred back (no leak, no
 * orphan failure). Previously this returned EINVAL.
 */
test('K2: process/spawn with pipe action on fd 3 succeeds and transfers the parent end', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  // Register a resolver so the command is found.
  const NOOP_CMD = `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => { const g = createGuest(boot); g.exit(0); };`;
  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    resolveCommand: (name) => name === 'noop' ? NOOP_CMD : undefined,
  });

  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  kernel.capabilities.grant(parentPid, [{ type: 'process' }]);

  const { response, transfer } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'noop', argv: ['noop'], fds: { 3: { action: 'pipe' } } },
  });

  // Succeeds: fd 3 is wired as a preopen pipe; the parent end is transferred.
  expect(response.ok).toBe(true);
  expect((response as { ok: true; result: { pipes: Record<number, string> } }).result.pipes).toEqual({ 3: 'transferred' });
  expect(transfer).toHaveLength(1);
  expect(transfer![0]).toBeInstanceOf(MessagePort);
  const pid = (response as { ok: true; result: { pid: number } }).result.pid;
  await kernel.wait(pid);
}, 10000);

/**
 * K2: a process/spawn with a `dup2` injection on fd 3 SUCCEEDS — the guest-supplied
 * port is wired as the child's preopen at fd 3. Previously this returned EINVAL.
 */
test('K2: process/spawn with dup2 injection on fd 3 succeeds (wires the injected port)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const NOOP_CMD = `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => { const g = createGuest(boot); g.exit(0); };`;
  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    resolveCommand: (name) => name === 'noop' ? NOOP_CMD : undefined,
  });

  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  kernel.capabilities.grant(parentPid, [{ type: 'process' }]);

  // A port to inject at fd 3 via portFds + fds:{3:{action:'dup2'}}.
  const chan = new MessageChannel();
  const injectedPort = chan.port1;

  const { response } = await kernel.dispatcher.dispatch(
    parentPid,
    {
      id: 1,
      call: 'process/spawn',
      args: {
        path: 'noop', argv: ['noop'],
        fds: { 3: { action: 'dup2' } },
        portFds: [3],
      },
    },
    [injectedPort],
  );

  // Succeeds: the injected port is wired into the child's preopen fd 3.
  expect(response.ok).toBe(true);
  const pid = (response as { ok: true; result: { pid: number } }).result.pid;
  await kernel.wait(pid);
  chan.port2.close();
}, 10000);

// ── CAP-2: captured stdout must not hang when the guest writes past the cap ──

/**
 * CAP-2 regression: the transfer-path capture (`drainPort`) granted a fixed
 * 16MiB credit ONCE and never replenished. A guest writing more than that
 * exhausted the writer's credit, its `write()` stalled forever, and the capture
 * promise never resolved — `wait()`/the pipeline hung. The fix replenishes
 * credit as chunks are consumed and enforces a bounded `maxOutputBytes` cap:
 * the capture promise ALWAYS resolves (truncated at the cap), and the process
 * is killed so it cannot keep driving host allocations.
 */
test('CAP-2: captured stdout past the cap resolves (truncated) and does not hang', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  // Guest writes 4 chunks of 256 KiB = 1 MiB total to stdout, never closing
  // before the cap is hit. With a 512 KiB cap the writer would historically
  // stall after exhausting credit; the fix must still resolve the capture.
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      // Fresh buffer per write — the pipe transfers large buffers, so a reused
      // buffer would be detached after the first write (a guest must not reuse).
      for (let i = 0; i < 8; i++) {
        await w.write(new Uint8Array(256 * 1024).fill(65));
      }
      try { await w.close(); } catch {}
      g.exit(0);
    };`;
  const { pid, stdout } = await kernel.spawn(code, {
    args: ['flood'],
    capabilities: [],
    captureStdout: true,
    limits: { maxOutputBytes: 512 * 1024 },
  });

  // The capture promise MUST resolve (bounded) rather than hang forever.
  const captured = await withTimeout(stdout!, 12000, 'captured stdout never resolved (CAP-2 hang)');
  // Truncated at the cap (allow the exact cap; never the full 1 MiB).
  expect(captured.byteLength).toBeLessThanOrEqual(512 * 1024);
  expect(captured.byteLength).toBeGreaterThan(0);

  // wait() must settle too.
  const w = await withTimeout(kernel.wait(pid), 12000, 'wait() never settled (CAP-2 hang)');
  expect(typeof w.code).toBe('number');
}, 20000);

/** Reject after `ms` so a hung promise fails the test instead of timing out the runner. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

// ── LIM-1: kernel-side wall-clock timeout watchdog (works on ANY backend) ────

/**
 * LIM-1 regression: Kernel.spawn never enforced `limits.timeoutMs`, and the
 * Worker/iframe backends don't enforce timeouts themselves — so a caller passing
 * `limits.timeoutMs` got a silent no-op and a runaway guest ran forever. The fix
 * adds a kernel-side wall-clock watchdog that SIGKILLs an over-time process on
 * ANY backend; its `wait()` then resolves with a nonzero status within a bound.
 */
test('LIM-1: a never-exiting process with limits.timeoutMs is killed by the kernel watchdog', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  // A guest that never calls g.exit() and never returns — it parks forever.
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      createGuest(boot);
      await new Promise(() => {}); // never resolves
    };`;
  const t0 = Date.now();
  const { pid } = await kernel.spawn(code, {
    args: ['hang'],
    capabilities: [],
    limits: { timeoutMs: 200 },
  });

  // The watchdog must fire and the wait must resolve nonzero within a bound.
  const result = await withTimeout(kernel.wait(pid), 5000, 'watchdog never fired (LIM-1)');
  const elapsed = Date.now() - t0;
  expect(result.code).not.toBe(0);
  // Killed reasonably close to the deadline, not after the test bound.
  expect(elapsed).toBeLessThan(3000);
}, 10000);

test('LIM-1: a fast process that finishes before timeoutMs exits normally (watchdog cleared)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => { const g = createGuest(boot); g.exit(0); };`;
  const { pid } = await kernel.spawn(code, {
    args: ['quick'],
    capabilities: [],
    limits: { timeoutMs: 5000 },
  });
  const result = await withTimeout(kernel.wait(pid), 5000, 'fast process never exited (LIM-1)');
  // Exited 0 on its own — the watchdog must NOT have killed it (137).
  expect(result.code).toBe(0);
}, 10000);

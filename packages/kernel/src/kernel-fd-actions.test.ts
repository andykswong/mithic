/**
 * K2 — spawn fd actions for fd >= 3 and a real `open` action.
 *
 * Previously fd actions were limited to fds 0-2 (fd >= 3 pipe/dup2 → EINVAL),
 * `action:'open'` was silently degraded to inherit, and preopens were hardcoded
 * to {0,1,2}. Now:
 *   - a child can be spawned with a `pipe` action on fd >= 3 (the child gets a
 *     preopen pipe at that fd; the parent gets the other end transferred back).
 *   - `action:'open'` actually opens the VFS path into the child fd (read → the
 *     child can read the file's bytes at that fd; write → the child's writes land
 *     in the VFS file).
 *
 * These drive the dispatcher's `process/spawn` surface from the host side (the
 * same pattern as process-spawn-e2e.test.ts) because the guest-runtime
 * SyscallClient does not yet surface transferred ports to guest code — so the
 * parent-facing pipe ports are received via the dispatcher's `transfer` list.
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

/** Drain a kernel-side pipe READ port to EOF (credit protocol) → string. */
function drainPort(port: MessagePort): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    port.start?.();
    port.postMessage({ type: 'credit', bytes: 1 << 20 });
    port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; chunk?: Uint8Array };
      if (m?.type === 'data' && m.chunk) { chunks.push(m.chunk); port.postMessage({ type: 'credit', bytes: m.chunk.byteLength }); }
      else if (m?.type === 'end') {
        let n = 0; for (const c of chunks) n += c.byteLength;
        const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.byteLength; }
        resolve(new TextDecoder().decode(out));
      }
    };
  });
}

/** Write `data` into a kernel-side pipe WRITE port (credit protocol) then EOF. */
function feed(port: MessagePort, data: Uint8Array): void {
  port.start?.();
  let sent = false;
  port.onmessage = (e: MessageEvent) => {
    const m = e.data as { type?: string };
    if (m?.type === 'credit' && !sent) {
      sent = true;
      port.postMessage({ type: 'data', chunk: data });
      port.postMessage({ type: 'end' });
    }
  };
}

// A child that reads everything on preopen fd 3 and echoes it to stdout prefixed
// with "fd3:". Proves an extra preopen fd >= 3 is wired and readable in the guest.
const READ_FD3 = `import { createGuest } from '@mithic/guest-runtime';
  import { portToReadable } from '@mithic/guest-runtime/streams';
  export default async (boot) => {
    const g = createGuest(boot);
    const w = g.stdout.getWriter();
    const port = boot.preopenPorts[3];
    let s = '';
    if (port) {
      const rd = portToReadable(port).getReader();
      for (;;) { const { value, done } = await rd.read(); if (done) break; s += new TextDecoder().decode(value); }
    }
    await w.write(new TextEncoder().encode('fd3:' + s));
    await w.close();
    g.exit(0);
  };`;

// A child that reads ALL of stdin (fd 0) and echoes the total byte count to
// stdout as "count:<n>". Proves a `bytes` fd-0 action streams the full buffer in
// (a deadlock would hang past the test timeout instead of reporting the count).
const READ_STDIN_COUNT = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    const rd = g.stdin.getReader();
    let n = 0;
    for (;;) { const { value, done } = await rd.read(); if (done) break; n += value.byteLength; }
    const w = g.stdout.getWriter();
    await w.write(new TextEncoder().encode('count:' + n));
    await w.close();
    g.exit(0);
  };`;

// A child that writes "written-to-fd3" to preopen fd 3 (no stdout).
const WRITE_FD3 = `import { createGuest } from '@mithic/guest-runtime';
  import { portToWritable } from '@mithic/guest-runtime/streams';
  export default async (boot) => {
    const g = createGuest(boot);
    const port = boot.preopenPorts[3];
    if (port) {
      const w = portToWritable(port).getWriter();
      await w.write(new TextEncoder().encode('written-to-fd3'));
      await w.close();
    }
    g.exit(0);
  };`;

function makeKernel(vfs: FileSystemRouter): Kernel {
  return new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    resolveCommand: (name) =>
      name === 'readfd3' ? READ_FD3
        : name === 'writefd3' ? WRITE_FD3
          : name === 'readstdin' ? READ_STDIN_COUNT
            : undefined,
  });
}

function makeParent(kernel: Kernel): number {
  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  kernel.capabilities.grant(parentPid, [
    { type: 'process' },
    { type: 'fs', paths: ['/'], operations: ['read', 'write'] },
  ]);
  return parentPid;
}

test('K2: a pipe action on fd 3 wires a preopen pipe; parent writes, child reads', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = makeKernel(vfs);
  const parentPid = makeParent(kernel);

  // Spawn `readfd3` with fd 1 piped back (so we can read its echo) and fd 3 as a
  // fresh pipe (child gets the read end at fd 3; parent gets the write end).
  const { response, transfer } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1, call: 'process/spawn',
    args: { path: 'readfd3', argv: ['readfd3'], fds: { 1: { action: 'pipe' }, 3: { action: 'pipe' } } },
  });
  expect(response.ok).toBe(true);
  const r = (response as { ok: true; result: { pid: number; pipes: Record<number, string> } }).result;
  expect(r.pipes).toEqual({ 1: 'transferred', 3: 'transferred' });
  // transfer carries the parent-facing ports in fd order: [fd1 read end, fd3 write end].
  const [fd1Read, fd3Write] = transfer as MessagePort[];

  // Feed fd 3 then drain the child's stdout (fd 1).
  feed(fd3Write, new TextEncoder().encode('hello-fd3'));
  const out = await withTimeout(drainPort(fd1Read), 6000, 'child stdout never closed (K2 pipe fd3)');
  const w = await withTimeout(kernel.wait(r.pid), 6000, 'fd3-pipe child never settled (K2)');
  expect(w.code).toBe(0);
  expect(out).toBe('fd3:hello-fd3');
}, 12000);

test('K2: action:open wires a VFS file into the child fd (read path)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const fh = await vfs.open('/data.txt', { write: true, create: true });
  await vfs.write(fh, new TextEncoder().encode('file-contents'), 0);
  await vfs.close(fh);

  const kernel = makeKernel(vfs);
  const parentPid = makeParent(kernel);

  // fd 1 piped back; fd 3 = open('/data.txt', read). The kernel reads the file and
  // feeds its bytes into the child's fd-3 read port.
  const { response, transfer } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1, call: 'process/spawn',
    args: {
      path: 'readfd3', argv: ['readfd3'],
      fds: { 1: { action: 'pipe' }, 3: { action: 'open', path: '/data.txt', flags: { read: true } } },
    },
  });
  expect(response.ok).toBe(true);
  const r = (response as { ok: true; result: { pid: number } }).result;
  const fd1Read = (transfer as MessagePort[])[0];

  const out = await withTimeout(drainPort(fd1Read), 6000, 'open-read child stdout never closed (K2)');
  const w = await withTimeout(kernel.wait(r.pid), 6000, 'open-read child never settled (K2)');
  expect(w.code).toBe(0);
  // The child read /data.txt via fd 3.
  expect(out).toBe('fd3:file-contents');
}, 12000);

test('K2: action:open with write flags lands the child writes in the VFS file', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = makeKernel(vfs);
  const parentPid = makeParent(kernel);

  const { response } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1, call: 'process/spawn',
    args: {
      path: 'writefd3', argv: ['writefd3'],
      fds: { 3: { action: 'open', path: '/out.txt', flags: { write: true, create: true } } },
    },
  });
  expect(response.ok).toBe(true);
  const r = (response as { ok: true; result: { pid: number } }).result;
  const w = await withTimeout(kernel.wait(r.pid), 6000, 'open-write child never settled (K2)');
  expect(w.code).toBe(0);

  // Give the kernel's fd-3 drain a tick to flush the child's writes into the VFS.
  await new Promise((res) => setTimeout(res, 200));
  const fh = await vfs.open('/out.txt', { read: true });
  const bytes = await vfs.read(fh, 0, 1024);
  await vfs.close(fh);
  expect(new TextDecoder().decode(bytes)).toBe('written-to-fd3');
}, 12000);

test('R1: a bytes action on fd 0 streams a large byte buffer into the child stdin', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = makeKernel(vfs);
  const parentPid = makeParent(kernel);

  // 256 KiB exceeds the 64 KiB chunk window, so a credit-deadlock would hang past
  // the tight timeout below rather than report the full count.
  const data = new Uint8Array(256 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

  const { response, transfer } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1, call: 'process/spawn',
    args: {
      path: 'readstdin', argv: ['readstdin'],
      fds: { 0: { action: 'bytes', data }, 1: { action: 'pipe' } },
    },
  });
  expect(response.ok).toBe(true);
  const r = (response as { ok: true; result: { pid: number } }).result;
  const fd1Read = (transfer as MessagePort[])[0];

  const out = await withTimeout(drainPort(fd1Read), 6000, 'bytes-fed child stdout never closed (R1)');
  const w = await withTimeout(kernel.wait(r.pid), 6000, 'bytes-fed child never settled (R1)');
  expect(w.code).toBe(0);
  expect(out).toBe('count:' + data.length);
}, 12000);

test('R1: an empty bytes action delivers EOF immediately (count 0)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = makeKernel(vfs);
  const parentPid = makeParent(kernel);

  const { response, transfer } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1, call: 'process/spawn',
    args: {
      path: 'readstdin', argv: ['readstdin'],
      fds: { 0: { action: 'bytes', data: new Uint8Array(0) }, 1: { action: 'pipe' } },
    },
  });
  expect(response.ok).toBe(true);
  const r = (response as { ok: true; result: { pid: number } }).result;
  const fd1Read = (transfer as MessagePort[])[0];

  const out = await withTimeout(drainPort(fd1Read), 6000, 'empty-bytes child stdout never closed (R1)');
  const w = await withTimeout(kernel.wait(r.pid), 6000, 'empty-bytes child never settled (R1)');
  expect(w.code).toBe(0);
  expect(out).toBe('count:0');
}, 12000);

test('B1: a top-level kernel.spawn honors an fds[0] bytes stdin source (transferable backend)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = makeKernel(vfs);

  // 256 KiB exceeds the 64 KiB chunk window — a credit-deadlock would hang past
  // the timeout rather than report the full byte count.
  const data = new Uint8Array(256 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

  const { pid, stdout } = await kernel.spawn(READ_STDIN_COUNT, {
    args: ['readstdin'],
    capabilities: [],
    captureStdout: true,
    fds: { 0: { action: 'bytes', data } },
  });

  const out = new TextDecoder().decode(
    await withTimeout(stdout!, 6000, 'bytes-fed top-level spawn stdout never resolved (B1)'),
  );
  const w = await withTimeout(kernel.wait(pid), 6000, 'bytes-fed top-level spawn never settled (B1)');
  expect(w.code).toBe(0);
  expect(out).toBe('count:' + data.length);
}, 12000);

test('B1: a top-level kernel.spawn honors an fds[0] open stdin source, capability-checked', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = makeKernel(vfs);
  const fh = await vfs.open('/in.bin', { write: true, create: true });
  await vfs.write(fh, new TextEncoder().encode('0123456789'), 0);
  await vfs.close(fh);

  const { pid, stdout } = await kernel.spawn(READ_STDIN_COUNT, {
    args: ['readstdin'],
    capabilities: [{ type: 'fs', paths: ['/'], operations: ['read'] }],
    captureStdout: true,
    fds: { 0: { action: 'open', path: '/in.bin', flags: { read: true } } },
  });

  const out = new TextDecoder().decode(
    await withTimeout(stdout!, 6000, 'open-fed top-level spawn stdout never resolved (B1)'),
  );
  expect((await withTimeout(kernel.wait(pid), 6000, 'open-fed spawn never settled (B1)')).code).toBe(0);
  expect(out).toBe('count:10');
}, 12000);

test('B1: a top-level fds[0] open stdin source is capability-checked (EACCES, no leaked pid)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = makeKernel(vfs);
  const fh = await vfs.open('/secret.bin', { write: true, create: true });
  await vfs.write(fh, new TextEncoder().encode('nope'), 0);
  await vfs.close(fh);

  // No fs grant → the fd-0 open source must be denied before the process runs.
  await expect(kernel.spawn('readstdin', {
    args: ['readstdin'],
    capabilities: [],
    captureStdout: true,
    fds: { 0: { action: 'open', path: '/secret.bin', flags: { read: true } } },
  })).rejects.toThrow(/EACCES|permission denied/i);
}, 12000);

test('R1: a bytes action with non-Uint8Array data is rejected (EINVAL)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = makeKernel(vfs);
  const parentPid = makeParent(kernel);

  const { response } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1, call: 'process/spawn',
    args: {
      path: 'readstdin', argv: ['readstdin'],
      fds: { 0: { action: 'bytes', data: 'not-bytes' }, 1: { action: 'pipe' } },
    },
  });
  expect(response.ok).toBe(false);
  expect((response as { ok: false; error: { code: string } }).error.code).toBe('EINVAL');
}, 12000);

test('K2: a pipe action on a high fd (5) is also supported', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const READ_FD5 = `import { createGuest } from '@mithic/guest-runtime';
    import { portToReadable } from '@mithic/guest-runtime/streams';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      const port = boot.preopenPorts[5];
      let s = '';
      if (port) { const rd = portToReadable(port).getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; s += new TextDecoder().decode(value); } }
      await w.write(new TextEncoder().encode('fd5:' + s));
      await w.close();
      g.exit(0);
    };`;
  const kernel = new Kernel({
    runtime: new WorkerRuntime(), vfs,
    resolveCommand: (name) => (name === 'readfd5' ? READ_FD5 : undefined),
  });
  const parentPid = makeParent(kernel);

  const { response, transfer } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1, call: 'process/spawn',
    args: { path: 'readfd5', argv: ['readfd5'], fds: { 1: { action: 'pipe' }, 5: { action: 'pipe' } } },
  });
  expect(response.ok).toBe(true);
  const r = (response as { ok: true; result: { pid: number } }).result;
  const [fd1Read, fd5Write] = transfer as MessagePort[];
  feed(fd5Write, new TextEncoder().encode('high'));
  const out = await withTimeout(drainPort(fd1Read), 6000, 'fd5 child stdout never closed (K2)');
  const w = await withTimeout(kernel.wait(r.pid), 6000, 'fd5 child never settled (K2)');
  expect(w.code).toBe(0);
  expect(out).toBe('fd5:high');
}, 12000);

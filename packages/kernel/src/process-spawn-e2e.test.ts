import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/**
 * E2E proof that the `process/spawn` family lets a guest fork CHILD processes.
 *
 * A tiny `cat`-like guest command is registered with the kernel's command
 * resolver; a parent guest spawns it by NAME via `mithic.syscall('process/spawn')`
 * with stdout piped back, and (separately) runs an external-command pipeline via
 * `process/pipeline`. These prove the boundary works end-to-end without the
 * shell — the kernel resolves the command, narrows caps, wires fds, and reaps.
 */

// A child command: echoes its argv[1..] joined by spaces to stdout, exits 0.
const ECHO_CMD = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    const w = g.stdout.getWriter();
    await w.write(new TextEncoder().encode(g.args.slice(1).join(' ')));
    await w.close();
    g.exit(0);
  };`;

// A child command: uppercases everything it reads on stdin, writes to stdout.
const UPPER_CMD = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    let s = ''; const rd = g.stdin.getReader();
    for (;;) { const { value, done } = await rd.read(); if (done) break; s += new TextDecoder().decode(value); }
    const w = g.stdout.getWriter();
    await w.write(new TextEncoder().encode(s.toUpperCase()));
    await w.close();
    g.exit(0);
  };`;

function makeKernel() {
  const vfs = new FileSystemRouter();
  return vfs.mount('/', new MemoryFsProvider()).then(() => {
    const resolveCommand = (name: string): string | undefined => {
      if (name === 'echo') return ECHO_CMD;
      if (name === 'upper') return UPPER_CMD;
      return undefined;
    };
    return new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand });
  });
}

// Parent guest that runs a script via syscalls. The script is a small JS thunk
// (as a string) that receives `g` (the guest) and writes its result to stdout.
function parentGuest(thunkBody: string): string {
  return `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      try { ${thunkBody} } catch (e) {
        const ew = g.stderr.getWriter(); await ew.write(new TextEncoder().encode('ERR:'+(e.message||e))); await ew.close();
        g.exit(1); return;
      }
    };`;
}

test('a guest spawns a child by name via process/spawn and waits its exit', async () => {
  const kernel = await makeKernel();
  // Parent spawns `echo hi there`, waits, then reports the child's exit code.
  const parent = parentGuest(`
    const { pid } = await g.syscall('process/spawn', { path: 'echo', argv: ['echo', 'hi', 'there'] });
    const w = await g.syscall('process/wait', { pid });
    const out = g.stdout.getWriter();
    await out.write(new TextEncoder().encode('child pid='+pid+' code='+w.code+' status='+w.status));
    await out.close();
    g.exit(0);
  `);
  const { pid, stdout } = await kernel.spawn(parent, {
    args: ['parent'],
    capabilities: [{ type: 'process' }],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  const text = new TextDecoder().decode(await stdout!);
  expect(text).toContain('code=0');
  expect(text).toContain('status=exited');
}, 20000);

test('process/spawn of an unknown command name yields ENOENT to the guest', async () => {
  const kernel = await makeKernel();
  const parent = parentGuest(`
    let errCode = 'NONE';
    try { await g.syscall('process/spawn', { path: 'nonesuch', argv: ['nonesuch'] }); }
    catch (e) { errCode = e.code || 'ERR'; }
    const out = g.stdout.getWriter();
    await out.write(new TextEncoder().encode(errCode));
    await out.close();
    g.exit(0);
  `);
  const { pid, stdout } = await kernel.spawn(parent, {
    args: ['parent'],
    capabilities: [{ type: 'process' }],
    captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('ENOENT');
}, 20000);

test('process/spawn without a process capability yields EPERM', async () => {
  const kernel = await makeKernel();
  const parent = parentGuest(`
    let errCode = 'NONE';
    try { await g.syscall('process/spawn', { path: 'echo', argv: ['echo'] }); }
    catch (e) { errCode = e.code || 'ERR'; }
    const out = g.stdout.getWriter();
    await out.write(new TextEncoder().encode(errCode));
    await out.close();
    g.exit(0);
  `);
  // No process capability granted.
  const { pid, stdout } = await kernel.spawn(parent, {
    args: ['parent'],
    capabilities: [],
    captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('EPERM');
}, 20000);

test('a spawned child inherits NARROWED caps from the parent (cannot widen)', async () => {
  const kernel = await makeKernel();
  // Drive the dispatcher directly so we can inspect the child's granted caps
  // while it is still alive (before it exits and is reaped).
  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  // Parent holds a process cap + fs READ on /tmp (no write).
  kernel.capabilities.grant(parentPid, [
    { type: 'process' },
    { type: 'fs', paths: ['/tmp'], operations: ['read'] },
  ]);

  // Use a child command that blocks on stdin so it stays alive while we inspect.
  const { response } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1,
    call: 'process/spawn',
    // 'upper' reads stdin to EOF; with fd 0 piped, it won't get EOF until we
    // close the write end, so it stays RUNNING while we inspect its caps.
    args: { path: 'upper', argv: ['upper'], fds: { 0: { action: 'pipe' } } },
  });
  expect(response.ok).toBe(true);
  const childPid = (response as { result: { pid: number } }).result.pid;

  const childCaps = kernel.capabilities.capabilities(childPid);
  // The child inherits exactly the parent's caps — process + fs READ on /tmp.
  expect(childCaps).toContainEqual({ type: 'process', maxChildren: undefined });
  expect(childCaps).toContainEqual({ type: 'fs', paths: ['/tmp'], operations: ['read'] });
  // It must NOT have been widened to fs WRITE.
  const fsCaps = childCaps.filter((c) => c.type === 'fs');
  for (const c of fsCaps) {
    expect((c as { operations: string[] }).operations).not.toContain('write');
  }
  kernel.kill(childPid, 'SIGKILL');
}, 20000);

test('external-command pipeline runs via process/pipeline: echo | upper', async () => {
  const kernel = await makeKernel();
  const parent = parentGuest(`
    const r = await g.syscall('process/pipeline', { stages: [
      { path: 'echo', argv: ['echo', 'hello world'] },
      { path: 'upper', argv: ['upper'] },
    ]});
    const out = g.stdout.getWriter();
    await out.write(r.stdout);
    await out.close();
    g.exit(r.exitCodes[r.exitCodes.length - 1] ?? 0);
  `);
  const { pid, stdout } = await kernel.spawn(parent, {
    args: ['parent'],
    capabilities: [{ type: 'process' }],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('HELLO WORLD');
}, 20000);

test('process/spawn fd pipe-back: parent drains a child stdout pipe (dispatcher level)', async () => {
  const kernel = await makeKernel();
  // Drive the dispatcher directly with a kernel-owned parent pid that holds a
  // process cap, to assert the pipe-back transfer wiring of fds:{1:'pipe'}.
  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  kernel.capabilities.grant(parentPid, [{ type: 'process' }]);

  const { response, transfer } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'echo', argv: ['echo', 'piped'], fds: { 1: { action: 'pipe' } } },
  });
  expect(response.ok).toBe(true);
  expect((response as { result: { pipes: Record<number, string> } }).result.pipes).toEqual({ 1: 'transferred' });
  expect(transfer).toHaveLength(1);
  const readPort = transfer![0] as MessagePort;

  // Drain the child's stdout read end (the kernel transferred it back to us).
  const bytes = await new Promise<Uint8Array>((resolve) => {
    const chunks: Uint8Array[] = [];
    readPort.start?.();
    readPort.postMessage({ type: 'credit', bytes: 1 << 20 });
    readPort.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; chunk?: Uint8Array };
      if (m?.type === 'data' && m.chunk) chunks.push(m.chunk);
      else if (m?.type === 'end') {
        let total = 0; for (const c of chunks) total += c.byteLength;
        const out = new Uint8Array(total); let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.byteLength; }
        readPort.close();
        resolve(out);
      }
    };
  });
  expect(new TextDecoder().decode(bytes)).toBe('piped');
}, 20000);

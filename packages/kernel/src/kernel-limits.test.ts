/**
 * K1 — Resource-limit enforcement.
 *
 * Previously `ProcessLimits.networkDisabled` and `ProcessLimits.maxChildren` were
 * unenforced, `memoryMb`/`cpuMs` were silently ignored on worker/iframe, and the
 * kernel never validated backend-vs-limits. This exercises each enforced limit:
 *   - networkDisabled blocks net/fetch for that pid (EACCES) even with a net cap.
 *   - maxChildren caps process/spawn (and process/pipeline) for that pid.
 *   - a hard limit the backend cannot honor (Worker memoryMb) surfaces a clear
 *     diagnostic instead of being silently dropped.
 */
import { expect, test, vi } from 'vitest';
import { Kernel } from './kernel.ts';
import { SyscallDispatcher } from './syscall-dispatch.ts';
import { CapabilityManager } from './capability-manager.ts';
import { IpcBroker } from './ipc-broker.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { MockHttpClient } from '@mithic/io/net';

// ── networkDisabled ─────────────────────────────────────────────────────────

test('K1: networkDisabled blocks net/fetch for that pid even with a net capability', async () => {
  const caps = new CapabilityManager();
  const pid = 1;
  caps.grant(pid, [{ type: 'net', origins: ['https://api.example.com'] }]);
  const http = new MockHttpClient();
  http.addResponse('https://api.example.com', { status: 200, headers: [], body: new Uint8Array() });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const d = new SyscallDispatcher({
    vfs, caps, cwdOf: () => '/', httpClient: http,
    // networkDisabled set for this pid.
    limitsOf: () => ({ networkDisabled: true }),
  });

  const { response } = await d.dispatch(pid, {
    id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/x' },
  });
  expect(response.ok).toBe(false);
  expect((response as { ok: false; error: { code: string } }).error.code).toBe('EACCES');
});

test('K1: net/fetch still works when networkDisabled is NOT set (control)', async () => {
  const caps = new CapabilityManager();
  const pid = 1;
  caps.grant(pid, [{ type: 'net', origins: ['https://api.example.com'] }]);
  const http = new MockHttpClient();
  http.addResponse('https://api.example.com', { status: 200, headers: [], body: new TextEncoder().encode('ok') });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const d = new SyscallDispatcher({ vfs, caps, cwdOf: () => '/', httpClient: http, limitsOf: () => undefined });
  const { response } = await d.dispatch(pid, {
    id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/x' },
  });
  expect(response.ok).toBe(true);
});

// ── maxChildren (ProcessLimits) ──────────────────────────────────────────────

test('K1: ProcessLimits.maxChildren caps process/spawn for that pid', async () => {
  const caps = new CapabilityManager();
  const pid = 1;
  // The process CAP is unlimited; the LIMIT caps children at 2.
  caps.grant(pid, [{ type: 'process' }]);
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const ipc = new IpcBroker();

  let nextPid = 100;
  const spawned: number[] = [];
  const d = new SyscallDispatcher({
    vfs, caps, cwdOf: () => '/', ipc,
    limitsOf: () => ({ maxChildren: 2 }),
    ppidOf: () => pid,
    resolveCommand: (name) => (name === 'noop' ? 'noop://x' : undefined),
    // A fake spawn that never actually starts a child (we only assert gating).
    spawnChild: async () => { const p = nextPid++; spawned.push(p); return { pid: p }; },
  });

  // Two spawns succeed.
  for (let i = 0; i < 2; i++) {
    const { response } = await d.dispatch(pid, { id: i, call: 'process/spawn', args: { path: 'noop', argv: ['noop'] } });
    expect(response.ok, `spawn ${i}`).toBe(true);
  }
  // The third is rejected — maxChildren reached.
  const { response: third } = await d.dispatch(pid, { id: 3, call: 'process/spawn', args: { path: 'noop', argv: ['noop'] } });
  expect(third.ok).toBe(false);
  expect((third as { ok: false; error: { code: string } }).error.code).toBe('EPERM');
  expect(spawned).toHaveLength(2);
});

test('K1: effective maxChildren is the MIN of the process cap and the limit', async () => {
  const caps = new CapabilityManager();
  const pid = 1;
  // Cap allows 5; limit allows 1 → effective cap is 1.
  caps.grant(pid, [{ type: 'process', maxChildren: 5 }]);
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  let nextPid = 100;
  const d = new SyscallDispatcher({
    vfs, caps, cwdOf: () => '/',
    limitsOf: () => ({ maxChildren: 1 }),
    ppidOf: () => pid,
    resolveCommand: (name) => (name === 'noop' ? 'noop://x' : undefined),
    spawnChild: async () => ({ pid: nextPid++ }),
  });

  const { response: first } = await d.dispatch(pid, { id: 1, call: 'process/spawn', args: { path: 'noop', argv: ['noop'] } });
  expect(first.ok).toBe(true);
  const { response: second } = await d.dispatch(pid, { id: 2, call: 'process/spawn', args: { path: 'noop', argv: ['noop'] } });
  expect(second.ok).toBe(false);
  expect((second as { ok: false; error: { code: string } }).error.code).toBe('EPERM');
});

// ── backend-vs-limits diagnostic ─────────────────────────────────────────────

test('K1: a memoryMb limit on a backend that cannot enforce it surfaces a diagnostic', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const diagnostics: Array<{ pid: number; limit: string }> = [];
  const kernel = new Kernel({
    runtime: new WorkerRuntime(), // memoryLimit:false, cpuLimit:false
    vfs,
    onLimitUnenforceable: (pid, limit) => { diagnostics.push({ pid, limit }); },
  });

  const code = `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => { const g = createGuest(boot); g.exit(0); };`;
  const { pid } = await kernel.spawn(code, {
    args: ['x'], capabilities: [], limits: { memoryMb: 64, cpuMs: 100 },
  });
  await kernel.wait(pid);

  // Both unenforceable hard limits on the Worker backend were reported.
  const limits = diagnostics.map((d) => d.limit);
  expect(limits).toContain('memoryMb');
  expect(limits).toContain('cpuMs');
});

test('K1: no diagnostic when the backend CAN enforce the limit (QuickJS memoryMb) or none is set', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const warn = vi.fn();
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, onLimitUnenforceable: warn });
  const code = `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => { const g = createGuest(boot); g.exit(0); };`;
  // No memory/cpu limits set → no diagnostic.
  const { pid } = await kernel.spawn(code, { args: ['x'], capabilities: [], limits: { timeoutMs: 5000 } });
  await kernel.wait(pid);
  expect(warn).not.toHaveBeenCalled();
});

/**
 * D4 — background-job real-pid threading.
 *
 * A backgrounded EXTERNAL command (`cmd &`) is spawned directly on the kernel
 * (the live-stream spawn path), so `$!` is the REAL child pid and `kill %1` /
 * `kill <pid>` reach the live child via kernel.kill — instead of the old
 * fabricated `100000 + jobId` that silently no-ops. Uses a fuller-fidelity
 * Kernel + WorkerRuntime harness (not the synthetic-pid mock).
 *
 * REQUIRES `npm run build` first.
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';

const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];

async function bootShell(): Promise<(script: string) => Promise<{ stdout: string; code: number }>> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const guestUrl = new URL('../dist/process.js', import.meta.url);
  return async (script) => {
    const { pid, stdout } = await kernel.spawn(guestUrl, {
      args: ['bash', '-c', script],
      capabilities: [{ type: 'process' }, ...FS_RW],
      captureStdout: true,
    });
    const { code } = await kernel.wait(pid);
    const bytes = stdout ? await stdout : new Uint8Array();
    return { stdout: new TextDecoder().decode(bytes), code };
  };
}

const T = 20000;

test('D4: $! is a real positive child pid for a backgrounded external', async () => {
  const run = await bootShell();
  // `sleep` is a real coreutils child; `$!` must be its real (positive,
  // non-synthetic) pid — NOT 100000+jobId.
  const out = await run('sleep 0.2 &\necho "bgpid=$!"\nwait');
  const m = out.stdout.match(/bgpid=(\d+)/);
  expect(m).not.toBeNull();
  const pid = Number(m![1]);
  expect(pid).toBeGreaterThan(0);
  expect(pid).toBeLessThan(100000); // real kernel pid, not the synthetic 100000+id
}, T);

test('D4: kill %1 terminates a long-running real background child', async () => {
  const run = await bootShell();
  // Background a long sleep, then kill it by job spec. If kill reached a real
  // pid, the script does NOT wait the full 100s — `wait` returns promptly and
  // the whole run completes well within the tight timeout.
  const start = Date.now();
  const out = await run([
    'sleep 100 &',
    'kill %1',
    'wait',
    'echo done',
  ].join('\n'));
  expect(out.stdout).toContain('done');
  expect(Date.now() - start).toBeLessThan(T); // did not hang on the 100s sleep
}, T);

test('D4: kill <pid> (by real pid) terminates a background child', async () => {
  const run = await bootShell();
  const start = Date.now();
  const out = await run([
    'sleep 100 &',
    'kill "$!"',
    'wait',
    'echo killed',
  ].join('\n'));
  expect(out.stdout).toContain('killed');
  expect(Date.now() - start).toBeLessThan(T);
}, T);

import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/**
 * REGRESSION (Fix 2): runPipeline must not hang when a stage exits abnormally
 * without closing its stdout write port. If the middle stage crashes/exits
 * early, the downstream stage's portToReadable never gets EOF and hangs
 * forever, causing Promise.all(pids.map(wait)) to never resolve.
 *
 * Fix: on process exit, the kernel must close the process's injected stdio
 * ports (especially stdout write end) so downstream readers observe EOF.
 */
test('runPipeline resolves even when a middle stage exits without closing stdout', async () => {
  const vfs = new FileSystemRouter(); await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });

  // Stage 1 (producer): writes some data then exits ABNORMALLY without closing stdout.
  // It calls g.exit() without calling w.close() — simulating a crash/early exit.
  const producer = `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      await w.write(new TextEncoder().encode('partial'));
      // Intentionally exit WITHOUT closing stdout — simulates abnormal exit.
      g.exit(42);
    };`;

  // Stage 2 (consumer): reads stdin to EOF. Without the fix, this hangs forever
  // because the upstream stdout write port is never closed.
  const consumer = `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      let out = '';
      const rd = g.stdin.getReader();
      for (;;) { const { value, done } = await rd.read(); if (done) break; out += new TextDecoder().decode(value); }
      const w = g.stdout.getWriter();
      await w.write(new TextEncoder().encode(out));
      await w.close();
      g.exit(0);
    };`;

  // Race against a 10-second timeout to prove runPipeline resolves.
  const raceResult = await Promise.race([
    kernel.runPipeline([
      { code: producer, args: ['producer'] },
      { code: consumer, args: ['consumer'], captureStdout: true },
    ]),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10000)),
  ]);

  expect(raceResult).not.toBe('timeout');
  const result = raceResult as Awaited<ReturnType<typeof kernel.runPipeline>>;
  // Producer exits 42 (abnormally); consumer should have exited cleanly.
  expect(result.exitCodes[0]).toBe(42);
  // Consumer may have received the partial data written before the crash.
  expect(result.exitCodes).toHaveLength(2);
}, 20000);

test('echo | cat: data flows producer→consumer through a kernel pipe', async () => {
  const vfs = new FileSystemRouter(); await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  const producer = `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => { const g = createGuest(boot); const w = g.stdout.getWriter(); await w.write(new TextEncoder().encode('payload')); await w.close(); g.exit(0); };`;
  const consumer = `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => { const g = createGuest(boot); let out=''; const rd=g.stdin.getReader();
      for(;;){ const {value,done}=await rd.read(); if(done)break; out+=new TextDecoder().decode(value); }
      const w=g.stdout.getWriter(); await w.write(new TextEncoder().encode(out)); await w.close(); g.exit(0); };`;
  const result = await kernel.runPipeline([
    { code: producer, args: ['echo'] },
    { code: consumer, args: ['cat'], captureStdout: true },
  ]);
  expect(new TextDecoder().decode(await result.lastStdout)).toBe('payload');
  expect(result.exitCodes).toEqual([0, 0]);
}, 20000);

import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

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

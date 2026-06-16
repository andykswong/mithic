import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

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

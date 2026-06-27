import { describe, expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

// Guest reports the tty flags of its preopens 0/1/2 on stdout as JSON, using
// the real createGuest bootstrap (asserts actual runtime behavior, not types).
const REPORT_TTY = `
  import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    const p = boot.init.preopens || {};
    const out = JSON.stringify({
      0: p[0] && p[0].tty === true,
      1: p[1] && p[1].tty === true,
      2: p[2] && p[2].tty === true,
    });
    const w = g.stdout.getWriter();
    await w.write(new TextEncoder().encode(out));
    await w.close();
    g.exit(0);
  };`;

async function bootKernel(): Promise<Kernel> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  return new Kernel({ runtime: new WorkerRuntime(), vfs });
}

describe('kernel stdio tty preopens', () => {
  test('tty defaults to falsy on stdio preopens', async () => {
    const kernel = await bootKernel();
    const { pid, stdout } = await kernel.spawn(REPORT_TTY, { captureStdout: true });
    await kernel.wait(pid);
    const got = JSON.parse(new TextDecoder().decode(await stdout!));
    expect(got['0']).toBe(false);
    expect(got['1']).toBe(false);
    expect(got['2']).toBe(false);
  }, 15000);

  test('SpawnInit.tty marks stdio preopens as a terminal', async () => {
    const kernel = await bootKernel();
    const { pid, stdout } = await kernel.spawn(REPORT_TTY, { captureStdout: true, tty: true });
    await kernel.wait(pid);
    const got = JSON.parse(new TextDecoder().decode(await stdout!));
    expect(got['0']).toBe(true);
    expect(got['1']).toBe(true);
    expect(got['2']).toBe(true);
  }, 15000);

  test('PipelineStage.tty marks a pipeline stage stdio as a terminal', async () => {
    const kernel = await bootKernel();
    const { lastStdout } = await kernel.runPipeline([
      { code: REPORT_TTY, captureStdout: true, tty: true },
    ]);
    const got = JSON.parse(new TextDecoder().decode(await lastStdout!));
    expect(got['0']).toBe(true);
    expect(got['1']).toBe(true);
    expect(got['2']).toBe(true);
  }, 15000);

  test('PipelineStage.tty defaults to falsy when unset', async () => {
    const kernel = await bootKernel();
    const { lastStdout } = await kernel.runPipeline([
      { code: REPORT_TTY, captureStdout: true },
    ]);
    const got = JSON.parse(new TextDecoder().decode(await lastStdout!));
    expect(got['0']).toBe(false);
    expect(got['1']).toBe(false);
    expect(got['2']).toBe(false);
  }, 15000);
});

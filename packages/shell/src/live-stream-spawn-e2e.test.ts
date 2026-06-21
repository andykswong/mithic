/**
 * A1 — live-stream spawn path E2E.
 *
 * Proves the shell can hold a child's stdout as a LIVE ReadableStream instead of
 * a buffered `Promise<Uint8Array>`: a FOREGROUND command whose final stage is an
 * unbounded producer feeding head(1) terminates with the right output AND the
 * producer gets EPIPE (head closes early → kernel pipe breaks → `yes` stops),
 * and a large bounded producer streams to the shell's stdout without buffering
 * the whole thing first.
 *
 * Uses the real `@mithic/shell` dist guest + a real Kernel + WorkerRuntime with
 * the production coreutils resolver — the whole shell→kernel→coreutils stack.
 *
 * REQUIRES `npm run build` first (shell `dist/process.js` + coreutils guests).
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

const T = 15000;

// A SINGLE foreground external command's stdout streams live to the shell.
test('A1: a single foreground external command streams its stdout to the shell', async () => {
  const run = await bootShell();
  const out = await run('seq 1 5');
  expect(out.stdout).toBe('1\n2\n3\n4\n5\n');
  expect(out.code).toBe(0);
}, T);

// A multi-chunk foreground producer (output far exceeds a single pipe chunk and
// crosses the credit window several times) streams through the live path
// without dropping or reordering output. Exercises the chunked-drain loop.
test('A1: a multi-chunk foreground producer streams in order without loss', async () => {
  const run = await bootShell();
  const out = await run('seq 1 300');
  const lines = out.stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(300);
  expect(lines[0]).toBe('1');
  expect(lines[299]).toBe('300');
  expect(out.code).toBe(0);
}, T);

// Foreground pipeline: unbounded producer | head — terminates with 3 lines and
// the producer gets EPIPE (otherwise this HANGS and the timeout fails it).
test('A1: yes | head -n3 as a foreground command terminates with EPIPE to producer', async () => {
  const run = await bootShell();
  const out = await run('yes | head -n3');
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.code).toBe(0);
}, T);

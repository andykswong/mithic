/**
 * Bug B — the shell must SURFACE an external command's (and a pipeline stage's)
 * stderr to the terminal.
 *
 * Before the fix, `spawnExternal` and the pipeline drain set `captureStdout`
 * but never `captureStderr`, and never drained the child's captured stderr into
 * the shell's `io.stderr` sink. So a failing command (e.g. `cat /nonexistent`)
 * produced NOTHING on the terminal — not even its error — silently hiding every
 * external command's diagnostics. These tests drive the REAL Executor against a
 * REAL Kernel + WorkerRuntime with the production coreutils resolver, capturing
 * the shell's stdout/stderr sinks SEPARATELY, and assert the child's stderr text
 * reaches `onStderr`.
 *
 * REQUIRES `npm run build` first (shell dist + coreutils guests).
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';
import { Executor, parse } from './index.ts';
import type { KernelClient, SpawnParams, SpawnHandle, PipelineStageParams, PipelineRunResult } from './index.ts';

const CHILD_CAPS = [
  { type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] },
];

interface Sinks { stdout: string; stderr: string }

/** Boot a real Kernel + WorkerRuntime and return a runner that drives the Executor directly. */
async function bootExecutor(): Promise<(script: string) => Promise<{ code: number; sinks: Sinks }>> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const resolve = createCoreutilsResolver();

  // A KernelClient that threads BOTH stdout and stderr capture through.
  const exitCodes = new Map<number, number>();
  const kernelClient: KernelClient = {
    async spawn(params: SpawnParams): Promise<SpawnHandle> {
      // D8: one-stage runPipeline so a redirect-fed fds[0] is pipe-fed.
      const result = await kernel.runPipeline([{
        code: params.code,
        args: params.args,
        env: params.env,
        cwd: params.cwd,
        capabilities: CHILD_CAPS,
        captureStdout: params.captureStdout,
        captureStderr: params.captureStderr,
        fds: params.fds,
      }]);
      exitCodes.set(result.pids[0], result.exitCodes[0] ?? 0);
      return { pid: result.pids[0], stdout: result.lastStdout, stderr: result.stderr[0] };
    },
    async wait(pid: number) {
      const recorded = exitCodes.get(pid);
      if (recorded !== undefined) return { pid, code: recorded };
      const { code } = await kernel.wait(pid);
      return { pid, code };
    },
    async runPipeline(stages: PipelineStageParams[]): Promise<PipelineRunResult> {
      const result = await kernel.runPipeline(
        stages.map((s, i) => ({
          code: s.code,
          args: s.args,
          env: s.env,
          cwd: s.cwd,
          capabilities: CHILD_CAPS,
          captureStdout: i === stages.length - 1 ? s.captureStdout : false,
          captureStderr: s.captureStderr,
          fds: i === 0 ? s.fds : undefined,
        })),
      );
      return {
        pids: result.pids,
        exitCodes: result.exitCodes,
        lastStdout: result.lastStdout,
        stderr: result.stderr,
      };
    },
  };

  return async (script) => {
    const sinks: Sinks = { stdout: '', stderr: '' };
    const context = { cwd: '/', env: { HOME: '/', PWD: '/', PATH: '/bin' } as Record<string, string> };
    const executor = new Executor(kernelClient, context, {
      resolve: (name) => resolve(name, context.cwd, context.env),
      onStdout: (s) => { sinks.stdout += s; },
      onStderr: (s) => { sinks.stderr += s; },
    });
    const code = await executor.run(parse(script));
    return { code, sinks };
  };
}

const T = 30000;

test('Bug B: a failing single external command surfaces its stderr to the shell', async () => {
  const run = await bootExecutor();
  const { code, sinks } = await run('cat /nonexistent');
  // The child wrote a diagnostic to its stderr and exited non-zero.
  expect(code).not.toBe(0);
  expect(sinks.stderr).toMatch(/nonexistent/i);
  expect(sinks.stderr.length).toBeGreaterThan(0);
}, T);

test('Bug B: an early pipeline stage error reaches the shell stderr', async () => {
  const run = await bootExecutor();
  // `cat /nonexistent | cat` — the FIRST stage errors to stderr; that diagnostic
  // must be drained into the shell's stderr sink.
  const { sinks } = await run('cat /nonexistent | cat');
  expect(sinks.stderr).toMatch(/nonexistent/i);
}, T);

test('Bug B: a successful command does NOT spuriously emit on stderr', async () => {
  const run = await bootExecutor();
  const { code, sinks } = await run('seq 1 3');
  expect(code).toBe(0);
  expect(sinks.stdout).toBe('1\n2\n3\n');
  expect(sinks.stderr).toBe('');
}, T);

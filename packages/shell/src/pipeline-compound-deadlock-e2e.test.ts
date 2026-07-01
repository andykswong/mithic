/**
 * D5 — compound-stage pipeline serialization deadlock (REGRESSION TEST ONLY).
 *
 * Any pipeline with a COMPOUND stage (`{ ...; }`, `(...)`, `if`) or a `|&` join
 * routes to the fully-serialized in-process path (`Executor.execNodePipeline`),
 * which runs stage i to completion — buffering ALL of its stdout into a string —
 * BEFORE starting stage i+1. So when stage i is an UNBOUNDED producer (`yes`) or
 * a large-bounded one (`seq 1 100000`) and a later compound stage closes early
 * (`{ head -n3; }`), the producer is awaited forever: the downstream `head` that
 * would send EPIPE never even spawns. The pipeline HARD-HANGS.
 *
 * This is the one genuine correctness regression (plan §3 D5, sev HIGH). The
 * principled streaming fix is Stage 2; THIS file is only the failing regression
 * test that documents the bug. Modeled on `shell-infinite-producer-e2e.test.ts`
 * (real Kernel + WorkerRuntime + production coreutils resolver, driving the built
 * `@mithic/shell` `dist/process.js`) but with a COMPOUND stage in the pipeline.
 *
 * FIXED by D5-fix (Stage 2): a compound-stage pipeline whose stages each reduce
 * to a single simple command is flattened and routed through the CONCURRENT
 * kernel pipeline (execMultiStagePipeline → runPipeline), which streams
 * stage-to-stage and propagates EPIPE — so the unbounded/large producer
 * terminates when the downstream `head` closes early. These tests assert
 * TERMINATION within a tight timeout.
 *
 * REQUIRES `npm run build` first (shell `dist/process.js` + coreutils dist guests).
 */
import { expect, test, describe } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';

const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];

/** Boot a real Kernel + WorkerRuntime with the coreutils resolver, run a shell script. */
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

/**
 * Like {@link bootShell} but returns captured stdout as RAW bytes (no UTF-8
 * decode), and seeds each `files` entry (Uint8Array) into the MemoryFs via the
 * provider's synchronous open/write/close API — mirrors `binary-output-e2e`.
 */
async function runBytes(script: string, files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  const fs = new MemoryFsProvider({ files: {} });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  for (const [path, bytes] of Object.entries(files)) {
    const h = fs.open(path, { write: true, create: true });
    fs.write(h, bytes, 0);
    fs.close(h);
  }

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const guestUrl = new URL('../dist/process.js', import.meta.url);
  const { pid, stdout } = await kernel.spawn(guestUrl, {
    args: ['bash', '-c', script],
    capabilities: [{ type: 'process' }, ...FS_RW],
    captureStdout: true,
  });
  await kernel.wait(pid);
  return stdout ? await stdout : new Uint8Array();
}

// Tight timeout: a regression of the deadlock must FAIL fast, not stall CI.
const T = 8000;

describe('D5: compound-stage pipeline streaming (regression — terminates, no deadlock)', () => {
  test('yes | { head -n3; } → 3 lines and TERMINATES (unbounded producer into compound stage)', async () => {
    const run = await bootShell();
    const out = await run('yes | { head -n3; }');
    expect(out.stdout).toBe('y\ny\ny\n');
    expect(out.code).toBe(0);
  }, T);

  test('seq 1 100000 | cat | { head -n3; } → "1\\n2\\n3" (large producer through a compound stage)', async () => {
    const run = await bootShell();
    const out = await run('seq 1 100000 | cat | { head -n3; }');
    expect(out.stdout).toBe('1\n2\n3\n');
    expect(out.code).toBe(0);
  }, T);

  test('binary through a multi-statement compound stage is byte-exact', async () => {
    // /b.bin = 00 ff fe 41. `{ cat; printf Z; }` is a NON-flattenable compound stage
    // → execNodePipeline. The string-capture path corrupts 0xff/0xfe today.
    const outBytes = await runBytes('cat /b.bin | { cat; printf "Z"; }', { '/b.bin': new Uint8Array([0x00, 0xff, 0xfe, 0x41]) });
    expect(Array.from(outBytes)).toEqual([0x00, 0xff, 0xfe, 0x41, 0x5a]);
  }, T);

  test('unbounded producer into a multi-statement compound stage that exits early terminates', async () => {
    const run = await bootShell();
    const out = await run('yes | { head -n3; echo END; }');
    expect(out.stdout).toBe('y\ny\ny\nEND\n');
    expect(out.code).toBe(0);
  }, T);

  test('a large producer into a multi-statement compound stage streams (no full-buffer hang)', async () => {
    const run = await bootShell();
    const out = await run('seq 1 100000 | { head -n3; echo END; }');
    expect(out.stdout).toBe('1\n2\n3\nEND\n');
    expect(out.code).toBe(0);
  }, T);

  test('a large producer fully consumed by a compound stage streams', async () => {
    const run = await bootShell();
    const out = await run('seq 1 20000 | { cat; } | { wc -l; }');
    expect(out.stdout.trim()).toBe('20000');
    expect(out.code).toBe(0);
  }, T);
});

// A stage's `exit N` is subshell-local (bash runs each pipeline stage in a
// subshell): the pipeline status is the LAST stage's, and a stage's exit does not
// abort the parent shell. Covers BOTH the flattened all-builtin path and the
// concurrent execNodePipeline path.
describe('compound pipeline: a stage exit is subshell-local (matches bash)', () => {
  test('{ exit 3; } | cat → pipeline status 0 (last stage), parent survives', async () => {
    const run = await bootShell();
    const out = await run('{ exit 3; } | cat; echo "code=$?"');
    expect(out.stdout).toBe('code=0\n');
  }, T);

  test('{ exit 5; } | { exit 7; } → 7 (last stage wins)', async () => {
    const run = await bootShell();
    const out = await run('{ exit 5; } | { exit 7; }; echo "code=$?"');
    expect(out.stdout).toBe('code=7\n');
  }, T);

  test('a stage exit does NOT abort the parent shell', async () => {
    const run = await bootShell();
    const out = await run('{ exit 9; } | cat; echo AFTER');
    expect(out.stdout).toBe('AFTER\n');
  }, T);

  test('set -o pipefail; { exit 5; } | { exit 7; } → 7 (last nonzero)', async () => {
    const run = await bootShell();
    const out = await run('set -o pipefail; { exit 5; } | { exit 7; }; echo "code=$?"');
    expect(out.stdout).toBe('code=7\n');
  }, T);

  test('non-flattenable: { echo hi; exit 3; } | { cat; echo done; } streams + status 0', async () => {
    const run = await bootShell();
    const out = await run('{ echo hi; exit 3; } | { cat; echo done; }; echo "code=$?"');
    expect(out.stdout).toBe('hi\ndone\ncode=0\n');
  }, T);
});

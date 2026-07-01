/**
 * G3 — shell-level infinite-producer / broken-pipe pipeline TERMINATION.
 *
 * The coreutils package proves individual filters stream + early-terminate
 * (`infinite-stream-e2e.test.ts`) and that an UNBOUNDED producer | head
 * terminates at the KERNEL pipeline layer (`unbounded-pipe-epipe-e2e.test.ts`),
 * and guest-runtime proves the EPIPE wiring. But NOTHING exercised the deadlock
 * layer THROUGH THE ACTUAL SHELL: the real `@mithic/shell` process parsing a
 * pipeline, issuing `process/pipeline`, and the kernel wiring an UNBOUNDED
 * coreutils producer (`yes` / `seq`) into a head(1) that closes early.
 *
 * This is the regression that must fail FAST: if a future buffering filter (or a
 * lost EPIPE propagation) reintroduces the deadlock, these tests HANG → the tight
 * per-test timeout makes them FAIL rather than stalling CI.
 *
 * Modeled on `shell-coreutils-e2e.test.ts`: a real Kernel + WorkerRuntime whose
 * `resolveCommand` is the production coreutils resolver, driving the built
 * `@mithic/shell` `dist/process.js` with `bash -c '<pipeline>'`. The producers
 * here are the REAL unbounded coreutils `yes` / large-bounded `seq` — not inline
 * test guests — so the whole shell→kernel→coreutils stack is under test.
 *
 * REQUIRES `npm run build` first (shell `dist/process.js` + coreutils dist guests).
 */
import { expect, test } from 'vitest';
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

// Tight timeouts: a deadlock regression must FAIL fast, not stall CI.
const T = 10000;

test('yes | head -n3 → exactly 3 lines and TERMINATES (unbounded producer)', async () => {
  const run = await bootShell();
  const out = await run('yes | head -n3');
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.code).toBe(0);
}, T);

test('yes | tr y Y | head -n1 → "Y" and TERMINATES (wave-2 tr streaming, shell level)', async () => {
  const run = await bootShell();
  const out = await run('yes | tr y Y | head -n1');
  expect(out.stdout).toBe('Y\n');
  expect(out.code).toBe(0);
}, T);

test('yes hello | head -n2 → 2x "hello" and TERMINATES (producer with operand)', async () => {
  const run = await bootShell();
  const out = await run('yes hello | head -n2');
  expect(out.stdout).toBe('hello\nhello\n');
  expect(out.code).toBe(0);
}, T);

test('seq 1 100000 | head -n3 → "1\\n2\\n3" (large bounded producer, head closes early)', async () => {
  const run = await bootShell();
  const out = await run('seq 1 100000 | head -n3');
  expect(out.stdout).toBe('1\n2\n3\n');
  expect(out.code).toBe(0);
}, T);

test('yes | cut -c1 | head -n3 → "y\\ny\\ny" (the canonical multi-stage deadlock case)', async () => {
  const run = await bootShell();
  const out = await run('yes | cut -c1 | head -n3');
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.code).toBe(0);
}, T);

// ── IN-PROCESS BUILTIN producer broken-pipe backstop (SIGPIPE-equivalent) ──────
//
// The tests above use EXTERNAL producers (`yes`/`seq`): the KERNEL sends EPIPE
// when `head` closes early. But an IN-PROCESS BUILTIN producer loop
// (`while :; do echo x; done`) writes via the synchronous `ctx.write`, which
// used to SWALLOW the broken-pipe latch and spin forever (RSS unbounded). The
// backstop makes a broken sink THROW `BrokenPipeError` on the next write; the
// pipeline stage boundary catches it → the producer stops. These MUST terminate
// well within the timeout — a regression re-hangs and the timeout FAILS the test.
// (The while stage is a compound node, so this routes through execNodePipeline,
// not the flattened concurrent kernel path.)
const T_HANG = 15000;

test('while :; do echo x; done | { head -n3; } → "x\\nx\\nx" and TERMINATES (in-process builtin producer)', async () => {
  const run = await bootShell();
  const out = await run('while :; do echo x; done | { head -n3; }');
  expect(out.stdout).toBe('x\nx\nx\n');
  // The pipeline status is the LAST stage's (head succeeds → 0); the producer's
  // internal 141 is not surfaced as the pipeline status (matches bash PIPESTATUS).
  expect(out.code).toBe(0);
}, T_HANG);

test('while :; do echo x; done | head -n3; echo "s=$?" → producer stops, parent continues with status 0', async () => {
  const run = await bootShell();
  const out = await run('while :; do echo x; done | head -n3; echo "s=$?"');
  // KEY properties: correct downstream output, TERMINATION, and the parent shell
  // continues past the pipeline (reaching the trailing echo) with the last stage's
  // status (head → 0). Don't over-constrain the producer's exact 141 surfacing.
  expect(out.stdout.startsWith('x\nx\nx\n')).toBe(true);
  expect(out.stdout).toContain('s=0');
}, T_HANG);

test('for i in $(seq 1 100000); do echo "$i"; done | { head -n3; } → "1\\n2\\n3" and TERMINATES (for-loop builtin producer)', async () => {
  const run = await bootShell();
  const out = await run('for i in $(seq 1 100000); do echo "$i"; done | { head -n3; }');
  expect(out.stdout).toBe('1\n2\n3\n');
  expect(out.code).toBe(0);
}, T_HANG);

test('while :; do echo x; done | { cat; } | { head -n3; } → in-process producer through a MIDDLE stage TERMINATES', async () => {
  // The builtin producer feeds a MIDDLE compound stage (`cat`) whose own downstream
  // (`head`) closes early. When `cat` exits, the pipeline must break the producer's
  // upstream sink (else `cat`'s stdin reader is abandoned-but-locked and the
  // producer's next backpressured write strands, re-hanging). Guards the abort path.
  const run = await bootShell();
  const out = await run('while :; do echo x; done | { cat; } | { head -n3; }');
  expect(out.stdout).toBe('x\nx\nx\n');
  expect(out.code).toBe(0);
}, T_HANG);

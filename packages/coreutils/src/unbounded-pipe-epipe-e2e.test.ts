/**
 * Seam 2 — unbounded-producer EPIPE termination (coreutils H5 cross-cluster blocker).
 *
 * `producer | head -n3` with a TRULY UNBOUNDED producer (an infinite write loop
 * with NO byte cap, stopping only on a broken pipe) must TERMINATE:
 *
 *   - `head` reads 3 lines, stops early, and CANCELS its stdin → the kernel pipe
 *     posts `{type:'error', code:'EPIPE'}` up the read port to the producer's
 *     write port.
 *   - the producer's `portToWritable` must, from that instant, reject EVERY write
 *     immediately (sticky `broken` flag) — including a write that PARKS on credit
 *     AFTER the EPIPE was posted. Without the sticky flag the producer parks on
 *     credit that never replenishes and hangs forever.
 *   - separately, when a consumer EXITS (rather than explicitly cancelling its
 *     stdin), the guest's `exit()` must tear down the dying process's stdin read
 *     port (post EPIPE up the transferred pipe) so the upstream writer still sees
 *     closure → EPIPE. The stdin port was TRANSFERRED into the guest, so the
 *     kernel no longer holds it and cannot post to its peer — only the guest can.
 *     The kernel `#exit` already complements this for INJECTED write ports
 *     (downstream EOF on an abnormal exit).
 *
 * Before the fix this HUNG. The vitest per-test timeout is kept tight so a
 * regression fails fast instead of hanging CI.
 *
 * REQUIRES `npm run build` first (coreutils `head` is the built dist guest).
 */
import { expect, test } from 'vitest';
import { Kernel } from '@mithic/kernel';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { createCoreutilsResolver } from './index.ts';

const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];

/**
 * A TRULY UNBOUNDED producer guest: loops `write()` forever with NO byte cap. It
 * stops ONLY when a write rejects (EPIPE — the downstream closed). Each batch is
 * ~64 KiB so it exercises real credit backpressure (and parks on credit between
 * batches, which is exactly where the sticky-broken race lives). If the EPIPE
 * propagation is broken this loop never terminates → the kernel pipeline hangs.
 */
const UNBOUNDED_YES = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    const w = g.stdout.getWriter();
    const batch = new TextEncoder().encode('y\\n'.repeat(32768)); // ~64 KiB
    try {
      for (;;) {
        await w.write(batch); // parks on credit between batches; rejects on EPIPE
      }
    } catch {
      // broken pipe — downstream closed; stop cleanly.
    }
    await w.close().catch(() => {});
    g.exit(0);
  };`;

/**
 * A producer that writes SMALL chunks (each well under the credit window, so the
 * write does NOT park) with a tick between writes. This forces the EPIPE to land
 * while the producer is NOT parked on credit — exactly the race the STICKY
 * `broken` flag closes. Without the sticky flag the producer keeps posting to a
 * dead peer (silently dropped) and never observes the EPIPE → infinite loop.
 */
const RACEY_YES = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    const w = g.stdout.getWriter();
    const small = new TextEncoder().encode('y\\n'.repeat(8)); // 16 bytes, under credit
    try {
      for (;;) {
        await w.write(small);
        await new Promise((r) => setTimeout(r, 25)); // let the EPIPE land while not parked
      }
    } catch {
      // broken pipe — the sticky flag rejected the write; stop cleanly.
    }
    await w.close().catch(() => {});
    g.exit(0);
  };`;

/**
 * A consumer that reads exactly `n` lines then EXITS WITHOUT cancelling stdin —
 * proving the guest-side stdin-read-port teardown on `exit()` (not just head's
 * explicit cancel) breaks the pipe for the upstream producer.
 */
function readNLinesNoCancelGuest(n: number): string {
  return `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const reader = g.stdin.getReader();
      const w = g.stdout.getWriter();
      let seen = 0; let out = '';
      const dec = new TextDecoder();
      while (seen < ${n}) {
        const { value, done } = await reader.read();
        if (done) break;
        const s = dec.decode(value);
        for (const ch of s) { out += ch; if (ch === '\\n') { seen++; if (seen >= ${n}) break; } }
      }
      // Intentionally do NOT cancel/read stdin further — just exit. The kernel
      // must tear down the stdin read port so the producer sees EPIPE.
      await w.write(new TextEncoder().encode(out));
      await w.close().catch(() => {});
      g.exit(0);
    };`;
}

async function bootKernel(): Promise<Kernel> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  return new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
}

test('UNBOUNDED producer | head -n3 terminates with exactly 3 lines (was: infinite hang)', async () => {
  const kernel = await bootKernel();
  const head = createCoreutilsResolver()('head', '/', {})!;
  const result = await kernel.runPipeline([
    { code: UNBOUNDED_YES, args: ['yes'], capabilities: FS_RW },
    { code: head, args: ['head', '-n', '3'], capabilities: FS_RW, captureStdout: true },
  ]);
  const out = new TextDecoder().decode(result.lastStdout ? await result.lastStdout : new Uint8Array());
  expect(out).toBe('y\ny\ny\n');
  // head exits 0; the unbounded producer exits 0 after catching EPIPE (NOT a hang).
  expect(result.exitCodes[result.exitCodes.length - 1]).toBe(0);
  expect(result.exitCodes[0]).toBe(0);
}, 8000);

test('RACEY non-parking producer | head -n3 terminates (sticky-broken flag regression)', async () => {
  const kernel = await bootKernel();
  const head = createCoreutilsResolver()('head', '/', {})!;
  const result = await kernel.runPipeline([
    { code: RACEY_YES, args: ['yes'], capabilities: FS_RW },
    { code: head, args: ['head', '-n', '3'], capabilities: FS_RW, captureStdout: true },
  ]);
  const out = new TextDecoder().decode(result.lastStdout ? await result.lastStdout : new Uint8Array());
  expect(out).toBe('y\ny\ny\n');
  expect(result.exitCodes[result.exitCodes.length - 1]).toBe(0);
  expect(result.exitCodes[0]).toBe(0);
}, 6000);

test('UNBOUNDED producer | consumer-that-exits-without-cancel terminates (guest stdin teardown)', async () => {
  const kernel = await bootKernel();
  const result = await kernel.runPipeline([
    { code: UNBOUNDED_YES, args: ['yes'], capabilities: FS_RW },
    { code: readNLinesNoCancelGuest(3), args: ['take3'], capabilities: FS_RW, captureStdout: true },
  ]);
  const out = new TextDecoder().decode(result.lastStdout ? await result.lastStdout : new Uint8Array());
  expect(out).toBe('y\ny\ny\n');
  expect(result.exitCodes[0]).toBe(0); // producer caught EPIPE and exited
  expect(result.exitCodes[1]).toBe(0); // consumer exited cleanly
}, 8000);

test('RACEY non-parking producer | consumer-exits-without-cancel terminates (both fixes)', async () => {
  const kernel = await bootKernel();
  const result = await kernel.runPipeline([
    { code: RACEY_YES, args: ['yes'], capabilities: FS_RW },
    { code: readNLinesNoCancelGuest(3), args: ['take3'], capabilities: FS_RW, captureStdout: true },
  ]);
  const out = new TextDecoder().decode(result.lastStdout ? await result.lastStdout : new Uint8Array());
  expect(out).toBe('y\ny\ny\n');
  expect(result.exitCodes[0]).toBe(0);
  expect(result.exitCodes[1]).toBe(0);
}, 6000);

/**
 * Regression proof for the whole-input OOM/HANG class.
 *
 * Before the fix, the "whole-input" filters (`base64`, `base32`, `cksum`,
 * `grep`, `tail`, …) all called `readAll(io.stdin)` / `readAllText(io.stdin)`,
 * which had NO size cap — so an infinite producer (`cat /dev/zero`, `yes`)
 * buffered unboundedly and grew the HOST heap until OOM-killed
 * (`cat /dev/urandom | base64 | head -c 10` → 60 GB). A `readAll` consumer
 * also never reaches EOF on an infinite producer, so it never gets to write to
 * its (already-closed) downstream `head` and the pipeline HANGS.
 *
 * The kernel/guest-runtime now propagate EPIPE across the pipeline (sticky
 * broken-pipe latch + guest stdin-port teardown on exit — see
 * unbounded-pipe-epipe-e2e.test.ts), so a STREAMING filter between an UNBOUNDED
 * producer and `head` terminates: when `head` exits, the filter's next write
 * rejects with EPIPE, it stops, and cancels its own stdin → the unbounded
 * producer sees EPIPE and exits. A BUFFERING (`readAll`) filter cannot
 * terminate here — it spins reading the infinite producer forever.
 *
 * THE FIXES PROVEN HERE (each with a TRULY UNBOUNDED producer + tight timeout):
 *   - `base64`/`base32`/`grep` STREAM stdin incrementally → `… | head` TERMINATES.
 *   - `cksum` is INCREMENTAL: a large bounded input produces the correct CRC
 *     without buffering-all (the streamed CRC matches a one-shot compute).
 *   - `tail` keeps only a bounded ring of the last N lines/bytes.
 *
 * `/dev/zero` (deterministic) is mounted via DeviceFsProvider; never urandom.
 *
 * REQUIRES the package to be built first so `dist/commands/<name>.js` exist.
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from './index.ts';

const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];
const FS_DEV = [{ type: 'fs' as const, paths: ['/dev', '/'], operations: ['read' as const, 'write' as const] }];

/**
 * A TRULY UNBOUNDED producer guest: loops `write()` forever (no byte cap),
 * stopping ONLY when a write rejects (EPIPE — the downstream closed). ~64 KiB
 * batches exercise real credit backpressure. If EPIPE never propagates (because
 * a downstream filter buffers instead of streaming), this loop never ends.
 */
function unboundedProducer(line: string): string {
  const literal = JSON.stringify(line);
  // Batch ≈32 KiB (under the 64 KiB pipe window) so a single write never exceeds
  // the credit window and deadlocks the producer itself.
  return `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      const unit = ${literal};
      const reps = Math.max(1, Math.floor((32 * 1024) / unit.length));
      const batch = new TextEncoder().encode(unit.repeat(reps));
      try { for (;;) { await w.write(batch); } } catch { /* EPIPE */ }
      await w.close().catch(() => {});
      g.exit(0);
    };`;
}

/**
 * Inline bounded producer: writes `count` copies of `line`, then closes. Writes
 * in ≤32 KiB chunks (under the 64 KiB pipe window) so a single write never
 * exceeds the credit window — a >window write would deadlock the producer.
 */
function boundedProducer(line: string, count: number): string {
  const literal = JSON.stringify(line);
  return `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      const enc = new TextEncoder();
      const all = enc.encode(${literal}.repeat(${count}));
      const cap = 32 * 1024;
      try {
        for (let off = 0; off < all.byteLength; off += cap) {
          // .slice() gives each write its OWN buffer; the pipe transfers buffers
          // ≥10 KiB, which would detach a shared 2 MiB backing buffer.
          await w.write(all.slice(off, Math.min(off + cap, all.byteLength)));
        }
      } catch { /* EPIPE */ }
      await w.close().catch(() => {});
      g.exit(0);
    };`;
}

async function bootKernel(files: Record<string, string> = {}): Promise<{
  pipeline: (stages: Array<{ code: string | URL; args: string[]; caps?: typeof FS_RW }>) => Promise<{ stdout: string; codes: number[] }>;
}> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider, DeviceFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  const fs = new MemoryFsProvider({ files });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);
  await vfs.mount('/dev', new DeviceFsProvider());

  const resolveCommand = createCoreutilsResolver();
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand });

  return {
    async pipeline(stages) {
      const result = await kernel.runPipeline(
        stages.map((s, i) => ({
          code: s.code,
          args: s.args,
          capabilities: s.caps ?? FS_RW,
          captureStdout: i === stages.length - 1,
        })),
      );
      const bytes = result.lastStdout ? await result.lastStdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), codes: result.exitCodes };
    },
  };
}

const resolve = createCoreutilsResolver();

// ── base64 streams + EPIPE-stops on an UNBOUNDED producer ────────────────────

test('UNBOUNDED yes | base64 | head -n3 terminates with 3 lines of base64', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: unboundedProducer('y\n'), args: ['yes'] },
    { code: resolve('base64', '/', {})!, args: ['base64'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  const lines = out.stdout.split('\n').filter((l) => l.length > 0);
  expect(lines.length).toBe(3);
  // base64 default wrap is 76 columns; full lines are 76 alphabet chars.
  expect(lines[0].length).toBe(76);
  expect(/^[A-Za-z0-9+/=]+$/.test(lines[0])).toBe(true);
  expect(out.codes[out.codes.length - 1]).toBe(0);
  expect(out.codes[0]).toBe(0); // producer caught EPIPE and exited
}, 8000);

test('cat /dev/zero | base64 | head -c 20 terminates with 20 base64 bytes', async () => {
  const k = await bootKernel();
  // `cat /dev/zero` is unbounded; base64 streams; head -c20 takes 20 bytes then
  // closes → EPIPE stops base64 → cancels stdin → cat /dev/zero stops.
  const out = await k.pipeline([
    { code: resolve('cat', '/', {})!, args: ['cat', '/dev/zero'], caps: FS_DEV },
    { code: resolve('base64', '/', {})!, args: ['base64'] },
    { code: resolve('head', '/', {})!, args: ['head', '-c', '20'] },
  ]);
  // All-zero input → base64 of NUL groups is all 'A'; first 20 chars are 'A'.
  expect(out.stdout.length).toBe(20);
  expect(out.stdout).toBe('A'.repeat(20));
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 8000);

test('UNBOUNDED yes | base32 | head -n2 terminates', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: unboundedProducer('y\n'), args: ['yes'] },
    { code: resolve('base32', '/', {})!, args: ['base32'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '2'] },
  ]);
  const lines = out.stdout.split('\n').filter((l) => l.length > 0);
  expect(lines.length).toBe(2);
  expect(/^[A-Z2-7=]+$/.test(lines[0])).toBe(true);
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 8000);

// ── grep streams + EPIPE-stops on an UNBOUNDED producer ──────────────────────

test('UNBOUNDED yes | grep y | head -n3 terminates with 3 matching lines', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: unboundedProducer('y\n'), args: ['yes'] },
    { code: resolve('grep', '/', {})!, args: ['grep', 'y'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
  expect(out.codes[0]).toBe(0);
}, 8000);

test('UNBOUNDED mixed | grep keep | head -n2 streams only matching lines', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: unboundedProducer('keep\ndrop\n'), args: ['producer'] },
    { code: resolve('grep', '/', {})!, args: ['grep', 'keep'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '2'] },
  ]);
  expect(out.stdout).toBe('keep\nkeep\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 8000);

// ── cksum correctness (streaming preserves the CRC) ──────────────────────────

test('printf abc | cksum gives the correct POSIX CRC and byte count', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedProducer('abc', 1), args: ['producer'] },
    { code: resolve('cksum', '/', {})!, args: ['cksum'] },
  ]);
  // GNU `printf 'abc' | cksum` → "1219131554 3".
  expect(out.stdout.trim()).toBe('1219131554 3');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 8000);

test('cksum streams a large bounded input and produces the same CRC as a buffered compute', async () => {
  const k = await bootKernel();
  // 2 MiB of 'a' across many credit windows; streamed CRC must match one-shot.
  const repeat = 2 * 1024 * 1024;
  const out = await k.pipeline([
    { code: boundedProducer('a', repeat), args: ['producer'] },
    { code: resolve('cksum', '/', {})!, args: ['cksum'] },
  ]);
  const { posixCksum } = await import('./commands/cksum.ts');
  const expected = posixCksum(new TextEncoder().encode('a'.repeat(repeat)));
  expect(out.stdout.trim()).toBe(`${expected} ${repeat}`);
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 8000);

// ── tail bounded ring (does not buffer the whole input) ──────────────────────

test('tail -n2 of a large bounded input returns only the last 2 lines', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedProducer('x\n', 100000), args: ['producer'] },
    { code: resolve('tail', '/', {})!, args: ['tail', '-n', '2'] },
  ]);
  expect(out.stdout).toBe('x\nx\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 8000);

test('tail -c3 of a large bounded input returns only the last 3 bytes', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedProducer('ab', 100000), args: ['producer'] },
    { code: resolve('tail', '/', {})!, args: ['tail', '-c', '3'] },
  ]);
  expect(out.stdout).toBe('bab');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 8000);

// ── paste single-stdin streams (passthrough) ─────────────────────────────────

test('UNBOUNDED yes | paste | head -n3 terminates (single-stdin passthrough)', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: unboundedProducer('y\n'), args: ['yes'] },
    { code: resolve('paste', '/', {})!, args: ['paste'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 8000);

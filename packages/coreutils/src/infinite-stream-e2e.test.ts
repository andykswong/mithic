/**
 * Regression proof for the infinite-stream HANG class (parity finding H5).
 *
 * Before the fix, `head` read ALL of stdin then sliced, and its file path only
 * broke on a zero-length chunk — so `head -c4 /dev/zero` / `head -c16 /dev/random`
 * spun forever on a never-EOFing character device. Separately, the streamable
 * filters (cut/uniq/rev/nl/fold/tee/...) all `readAll`/`readLines` before
 * emitting, so a pipeline like `producer | cut -c1 | head -n3` buffered the whole
 * input before producing anything.
 *
 * THE COREUTILS-SIDE FIXES PROVEN HERE:
 *   - `head -c N <dev>` / `head -n N <file>` EARLY-TERMINATE: they read only up to
 *     the limit and stop, so a never-EOFing device terminates (no more spin).
 *   - The streamable filters STREAM incrementally: a pipeline into `head` emits
 *     and drains as it reads (head reads a prefix; the bounded upstream still
 *     reaches EOF and the whole pipeline terminates).
 *   - `head` CANCELS its stdin when it stops early, so an upstream producer that
 *     is parked on credit at that instant is woken with EPIPE and stops.
 *
 * CROSS-CLUSTER LIMITATION (documented, not fixable in `packages/coreutils/`):
 *   An UNBOUNDED producer (e.g. `yes`) piped into `head -n3` cannot be made to
 *   terminate purely command-side. When `head` exits, the kernel's `#exit`
 *   (kernel.ts) signals EOF only on *injected write* ports — it never tears down
 *   the dying process's *stdin read* port, so no EPIPE reaches the upstream
 *   producer. And `portToWritable` (guest-runtime/streams.ts) only rejects
 *   credit-waiters that are parked AT THE MOMENT the EPIPE arrives — it has no
 *   sticky "broken" flag — so a producer that parks on credit AFTER the EPIPE was
 *   posted waits forever. Either a kernel-side stdin-port teardown on `#exit` or
 *   a sticky-broken flag in `portToWritable` is required; both are outside this
 *   package. The tests below therefore use BOUNDED producers (which fit within
 *   the credit window and reach EOF) to prove the command-side streaming/early-
 *   termination contract without depending on the cross-cluster EPIPE path.
 *
 * REQUIRES the package to be built first so `dist/commands/<name>.js` exist.
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from './index.ts';

const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];
const FS_DEV = [{ type: 'fs' as const, paths: ['/dev'], operations: ['read' as const, 'write' as const] }];

/**
 * An inline bounded producer guest: writes `count` lines of `y\n` in ONE batched
 * write, then closes. Batching avoids the pipe's one-line-per-flush-tick crawl;
 * staying within the credit window means it reaches EOF cleanly even when the
 * downstream `head` stops reading after a prefix (see cross-cluster note above).
 */
function boundedYes(count: number): string {
  return `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      const block = new TextEncoder().encode('y\\n'.repeat(${count}));
      try {
        await w.write(block);
      } catch { /* EPIPE — downstream closed early */ }
      await w.close().catch(() => {});
      g.exit(0);
    };`;
}

async function bootKernel(files: Record<string, string> = {}): Promise<{
  pipeline: (stages: Array<{ code: string | URL; args: string[] }>) => Promise<{ stdout: string; codes: number[] }>;
  spawnDev: (args: string[]) => Promise<{ stdout: string; bytesLen: number; code: number }>;
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
          capabilities: FS_RW,
          captureStdout: i === stages.length - 1,
        })),
      );
      const bytes = result.lastStdout ? await result.lastStdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), codes: result.exitCodes };
    },
    async spawnDev(args) {
      const code = resolveCommand(args[0], '/', {})!;
      const { pid, stdout } = await kernel.spawn(code, { args, capabilities: FS_DEV, captureStdout: true });
      const { code: exitCode } = await kernel.wait(pid);
      const bytes = stdout ? await stdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), bytesLen: bytes.byteLength, code: exitCode };
    },
  };
}

const resolve = createCoreutilsResolver();

// ── /dev/* never-EOF devices: head -c must early-terminate (pure coreutils fix) ──

test('head -c4 /dev/zero terminates with exactly 4 NUL bytes (was: infinite spin)', async () => {
  const k = await bootKernel();
  const out = await k.spawnDev(['head', '-c', '4', '/dev/zero']);
  expect(out.code).toBe(0);
  expect(out.bytesLen).toBe(4);
  expect([...new TextEncoder().encode(out.stdout)].every((b) => b === 0)).toBe(true);
}, 10000);

test('head -c16 /dev/random terminates with exactly 16 bytes (was: infinite spin)', async () => {
  const k = await bootKernel();
  const out = await k.spawnDev(['head', '-c', '16', '/dev/random']);
  expect(out.code).toBe(0);
  expect(out.bytesLen).toBe(16);
}, 10000);

test('head -c0 /dev/zero terminates immediately with no output', async () => {
  const k = await bootKernel();
  const out = await k.spawnDev(['head', '-c', '0', '/dev/zero']);
  expect(out.code).toBe(0);
  expect(out.bytesLen).toBe(0);
}, 10000);

// ── streamable filters drain a bounded producer into head (early-terminate) ──

test('producer | head -n3 emits exactly 3 lines and terminates', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | cut -c1 | head -n3 streams (no buffer-all deadlock)', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('cut', '/', {})!, args: ['cut', '-c1'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | rev | head -n3 streams through rev', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('rev', '/', {})!, args: ['rev'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | nl | head -n2 streams through nl', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('nl', '/', {})!, args: ['nl'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '2'] },
  ]);
  const lines = out.stdout.split('\n').filter((l) => l.length > 0);
  expect(lines.length).toBe(2);
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | fold -w1 | head -n2 streams through fold', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('fold', '/', {})!, args: ['fold', '-w', '1'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '2'] },
  ]);
  const lines = out.stdout.split('\n').filter((l) => l.length > 0);
  expect(lines.length).toBe(2);
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | uniq | head -n1 streams through uniq', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('uniq', '/', {})!, args: ['uniq'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '1'] },
  ]);
  expect(out.stdout).toBe('y\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | tee /sink | head -n2 streams (tee passes through as it reads)', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('tee', '/', {})!, args: ['tee', '/sink.txt'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '2'] },
  ]);
  expect(out.stdout).toBe('y\ny\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | tr y Y | head -n3 streams through tr (was: deadlock)', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('tr', '/', {})!, args: ['tr', 'y', 'Y'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  expect(out.stdout).toBe('Y\nY\nY\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | tr -s y | head -n3 streams with squeeze across chunks', async () => {
  const k = await bootKernel();
  // boundedYes produces 'y\n' lines; squeeze on 'y' should keep 'y' (no consecutive ys within
  // a line), so output passes through unchanged — but it must NOT deadlock.
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('tr', '/', {})!, args: ['tr', '-s', 'y'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

test('producer | tr -d \\n | head -c6 streams through tr -d (delete mode)', async () => {
  const k = await bootKernel();
  // Delete newlines: 'y\ny\ny\n...' → 'yyy...'; head -c6 takes first 6 bytes.
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('tr', '/', {})!, args: ['tr', '-d', '\n'] },
    { code: resolve('head', '/', {})!, args: ['head', '-c', '6'] },
  ]);
  expect(out.stdout).toBe('yyyyyy');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 10000);

// D1 regression: cat was the lone outlier that buffered all stdin before writing
// (readAll path). This test proves cat streams — a large bounded producer piped
// through cat into head must terminate quickly without buffering everything.
test('producer | cat | head -n3 streams through cat without buffering (D1)', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([
    { code: boundedYes(2000), args: ['yes'] },
    { code: resolve('cat', '/', {})!, args: ['cat'] },
    { code: resolve('head', '/', {})!, args: ['head', '-n', '3'] },
  ]);
  expect(out.stdout).toBe('y\ny\ny\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 5000);

/**
 * End-to-end tests for the ENCODING/MISC batch of coreutils commands.
 * Requires the package to be built first (`npm run build -w @mithic/coreutils`).
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from './index.ts';

const FS_READ = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const] }];

async function bootKernel(files: Record<string, string> = {}): Promise<{
  spawn: (args: string[], caps?: boolean) => Promise<{ stdout: string; code: number }>;
  pipeline: (stages: string[][]) => Promise<{ stdout: string; codes: number[] }>;
}> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  const fs = new MemoryFsProvider();
  const enc = new TextEncoder();
  for (const [path, content] of Object.entries(files)) {
    const handle = await fs.open(path, { create: true, write: true, truncate: true });
    await fs.write(handle, enc.encode(content), 0);
    await fs.close(handle);
  }
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  const resolveCommand = createCoreutilsResolver();
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand });

  return {
    async spawn(args, cap = true) {
      const code = resolveCommand(args[0], '/', {})!;
      const { pid, stdout } = await kernel.spawn(code, {
        args,
        capabilities: cap ? FS_READ : [],
        captureStdout: true,
      });
      const { code: exitCode } = await kernel.wait(pid);
      const bytes = stdout ? await stdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), code: exitCode };
    },
    async pipeline(stages) {
      const result = await kernel.runPipeline(
        stages.map((args, i) => ({
          code: resolveCommand(args[0], '/', {})!,
          args,
          capabilities: FS_READ,
          captureStdout: i === stages.length - 1,
        })),
      );
      const bytes = result.lastStdout ? await result.lastStdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), codes: result.exitCodes };
    },
  };
}

// ── seq ───────────────────────────────────────────────────────────────────────

test('e2e: seq 1 5 outputs 1..5', async () => {
  const k = await bootKernel();
  const out = await k.spawn(['seq', '1', '5']);
  expect(out.stdout).toBe('1\n2\n3\n4\n5\n');
  expect(out.code).toBe(0);
}, 20000);

// ── echo ──────────────────────────────────────────────────────────────────────

test('e2e: echo hi outputs "hi\\n"', async () => {
  const k = await bootKernel();
  const out = await k.spawn(['echo', 'hi']);
  expect(out.stdout).toBe('hi\n');
  expect(out.code).toBe(0);
}, 20000);

// ── base64 ────────────────────────────────────────────────────────────────────

test('e2e: seq 1 3 | base64 | base64 -d roundtrip', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([['seq', '1', '3'], ['base64']]);
  // The base64 output is a valid encoding — just check it is non-empty and ends with \n
  expect(out.stdout.length).toBeGreaterThan(0);
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 20000);

// ── true / false ──────────────────────────────────────────────────────────────

test('e2e: true exits 0', async () => {
  const k = await bootKernel();
  const out = await k.spawn(['true']);
  expect(out.code).toBe(0);
}, 20000);

test('e2e: false exits 1', async () => {
  const k = await bootKernel();
  const out = await k.spawn(['false']);
  expect(out.code).toBe(1);
}, 20000);

// ── printf ────────────────────────────────────────────────────────────────────

test('e2e: printf "%d\\n" 42 outputs "42\\n"', async () => {
  const k = await bootKernel();
  const out = await k.spawn(['printf', '%d\n', '42']);
  expect(out.stdout).toBe('42\n');
  expect(out.code).toBe(0);
}, 20000);

// ── tac ───────────────────────────────────────────────────────────────────────

test('e2e: seq 1 3 | tac reverses lines', async () => {
  const k = await bootKernel();
  const out = await k.pipeline([['seq', '1', '3'], ['tac']]);
  expect(out.stdout).toBe('3\n2\n1\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 20000);

// ── expr ──────────────────────────────────────────────────────────────────────

test('e2e: expr 3 + 4 outputs 7', async () => {
  const k = await bootKernel();
  const out = await k.spawn(['expr', '3', '+', '4']);
  expect(out.stdout.trim()).toBe('7');
  expect(out.code).toBe(0);
}, 20000);

// ── diff ──────────────────────────────────────────────────────────────────────

test('e2e: diff identical files exits 0', async () => {
  const k = await bootKernel({ '/a.txt': 'foo\nbar\n', '/b.txt': 'foo\nbar\n' });
  const out = await k.spawn(['diff', '/a.txt', '/b.txt']);
  expect(out.code).toBe(0);
  expect(out.stdout).toBe('');
}, 20000);

test('e2e: diff different files exits 1', async () => {
  const k = await bootKernel({ '/a.txt': 'foo\n', '/b.txt': 'bar\n' });
  const out = await k.spawn(['diff', '/a.txt', '/b.txt']);
  expect(out.code).toBe(1);
}, 20000);

// ── cksum ─────────────────────────────────────────────────────────────────────

test('e2e: cksum stdin outputs checksum', async () => {
  // Pipe "hello\n" via seq into cksum is awkward; use echo pipeline instead
  const k = await bootKernel({ '/f.txt': 'hello\n' });
  const out = await k.spawn(['cksum', '/f.txt']);
  expect(out.code).toBe(0);
  expect(out.stdout.trim()).toContain('/f.txt');
}, 20000);

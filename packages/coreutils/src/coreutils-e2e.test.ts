/**
 * End-to-end proof of the whole coreutils mechanism:
 *   resolveCommand → kernel spawn → defineCommand → createGuest → stdio → exit.
 *
 * Boots a real Kernel over a WorkerRuntime with `resolveCommand =
 * createCoreutilsResolver()`, mounts a MemoryFs, and spawns `cat` for real. In a
 * Node/vitest env `Worker` is undefined, so the kernel's in-process launcher
 * imports the BUILT `dist/commands/cat.js` module by URL (the delivery mechanism)
 * and runs it on the same thread.
 *
 * REQUIRES the package to be built first (`npm run build -w @mithic/coreutils`)
 * so `dist/commands/cat.js` exists — the resolver hands the kernel that file URL.
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from './index.ts';

const FS_READ = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const] }];

async function bootKernel(files: Record<string, string>): Promise<{
  spawn: (args: string[], cap?: boolean) => Promise<{ stdout: string; code: number }>;
  pipeline: (stages: string[][]) => Promise<{ stdout: string; codes: number[] }>;
  producerInto: (producerSrc: string, cmd: string[]) => Promise<{ stdout: string; codes: number[] }>;
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
    // Pipe an inline producer (arbitrary guest code) into a coreutils command.
    // Proves a coreutils command reads its piped stdin end-to-end.
    async producerInto(producerSrc: string, cmd: string[]): Promise<{ stdout: string; codes: number[] }> {
      const result = await kernel.runPipeline([
        { code: producerSrc, args: ['producer'] },
        { code: resolveCommand(cmd[0], '/', {})!, args: cmd, capabilities: FS_READ, captureStdout: true },
      ]);
      const bytes = result.lastStdout ? await result.lastStdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), codes: result.exitCodes };
    },
  };
}

test('resolveCommand → kernel spawn → cat <file> emits file contents', async () => {
  const k = await bootKernel({ '/hello.txt': 'hello world\n' });
  const out = await k.spawn(['cat', '/hello.txt']);
  expect(out.stdout).toBe('hello world\n');
  expect(out.code).toBe(0);
}, 20000);

test('cat -n numbers lines end-to-end', async () => {
  const k = await bootKernel({ '/two.txt': 'one\ntwo\n' });
  const out = await k.spawn(['cat', '-n', '/two.txt']);
  expect(out.stdout).toBe('     1\tone\n     2\ttwo\n');
  expect(out.code).toBe(0);
}, 20000);

// An inline producer guest: writes a fixed string to stdout, then closes + exits.
const PRODUCER = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    const w = g.stdout.getWriter();
    await w.write(new TextEncoder().encode('streamed in\\n'));
    await w.close();
    g.exit(0);
  };`;

test('cat reads from stdin when given no file operands (producer | cat)', async () => {
  // No file operands → cat reads stdin. A producer writes to cat's stdin via a
  // zero-hop pipe; cat must emit exactly what it received.
  const k = await bootKernel({});
  const out = await k.producerInto(PRODUCER, ['cat']);
  expect(out.stdout).toBe('streamed in\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
}, 20000);

test('cat - reads stdin explicitly (producer | cat -)', async () => {
  const k = await bootKernel({});
  const out = await k.producerInto(PRODUCER, ['cat', '-']);
  expect(out.stdout).toBe('streamed in\n');
}, 20000);

test('cat <file> | cat pipes through end-to-end (zero-hop pipeline)', async () => {
  const k = await bootKernel({ '/p.txt': 'piped\n' });
  const out = await k.pipeline([['cat', '/p.txt'], ['cat']]);
  expect(out.stdout).toBe('piped\n');
  expect(out.codes).toEqual([0, 0]);
}, 20000);

test('unknown command name resolves to undefined (kernel would ENOENT)', async () => {
  const resolve = createCoreutilsResolver();
  expect(resolve('definitely-not-a-command', '/', {})).toBeUndefined();
  expect(resolve('cat', '/', {})).toBeInstanceOf(URL);
});

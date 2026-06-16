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
const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];

async function bootKernel(files: Record<string, string>): Promise<{
  spawn: (args: string[], cap?: boolean) => Promise<{ stdout: string; code: number }>;
  rwSpawn: (args: string[]) => Promise<{ stdout: string; code: number }>;
  readFile: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  pipeline: (stages: string[][]) => Promise<{ stdout: string; codes: number[] }>;
  producerInto: (producerSrc: string, cmd: string[]) => Promise<{ stdout: string; codes: number[] }>;
}> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  // Seed via the constructor `files` option so nested paths auto-create parents.
  const fs = new MemoryFsProvider({ files });
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
    // Spawn with read+write fs caps (for commands that mutate the VFS).
    async rwSpawn(args) {
      const code = resolveCommand(args[0], '/', {})!;
      const { pid, stdout } = await kernel.spawn(code, { args, capabilities: FS_RW, captureStdout: true });
      const { code: exitCode } = await kernel.wait(pid);
      const bytes = stdout ? await stdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), code: exitCode };
    },
    // Read a VFS file directly (to verify the side effects of a command).
    async readFile(path) {
      const handle = await fs.open(path, { read: true });
      const data = await fs.read(handle, 0, 1 << 20);
      await fs.close(handle);
      return new TextDecoder().decode(data);
    },
    async exists(path) {
      try { await fs.stat(path); return true; } catch { return false; }
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

// ── file-operation commands end-to-end (real Kernel + MemoryFs) ─────────────

test('mkdir then ls shows the new directory', async () => {
  const k = await bootKernel({});
  const mk = await k.rwSpawn(['mkdir', '/d']);
  expect(mk.code).toBe(0);
  expect(await k.exists('/d')).toBe(true);
  const ls = await k.spawn(['ls', '-1', '/']);
  expect(ls.code).toBe(0);
  expect(ls.stdout).toContain('d');
}, 20000);

test('cp copies a file and the copy reads back through the kernel', async () => {
  const k = await bootKernel({ '/src.txt': 'payload\n' });
  const cp = await k.rwSpawn(['cp', '/src.txt', '/dst.txt']);
  expect(cp.code).toBe(0);
  expect(await k.readFile('/dst.txt')).toBe('payload\n');
  // And cat the copy back through a spawned process.
  const cat = await k.spawn(['cat', '/dst.txt']);
  expect(cat.stdout).toBe('payload\n');
}, 20000);

test('rm -r removes a tree through the kernel', async () => {
  const k = await bootKernel({ '/d/a': 'a', '/d/sub/b': 'b' });
  const rm = await k.rwSpawn(['rm', '-r', '/d']);
  expect(rm.code).toBe(0);
  expect(await k.exists('/d')).toBe(false);
}, 20000);

test('touch creates an empty file via the kernel', async () => {
  const k = await bootKernel({});
  const t = await k.rwSpawn(['touch', '/new.txt']);
  expect(t.code).toBe(0);
  expect(await k.exists('/new.txt')).toBe(true);
  expect(await k.readFile('/new.txt')).toBe('');
}, 20000);

test('mv renames through the kernel', async () => {
  const k = await bootKernel({ '/a.txt': 'data' });
  const mv = await k.rwSpawn(['mv', '/a.txt', '/b.txt']);
  expect(mv.code).toBe(0);
  expect(await k.exists('/a.txt')).toBe(false);
  expect(await k.readFile('/b.txt')).toBe('data');
}, 20000);

test('pwd prints the spawn cwd', async () => {
  const k = await bootKernel({});
  const out = await k.spawn(['pwd']);
  expect(out.code).toBe(0);
  expect(out.stdout).toBe('/\n');
}, 20000);

test('find -name through the kernel', async () => {
  const k = await bootKernel({ '/r/a.txt': '1', '/r/b.md': '2', '/r/sub/c.txt': '3' });
  const out = await k.spawn(['find', '/r', '-name', '*.txt']);
  expect(out.code).toBe(0);
  const lines = out.stdout.trim().split('\n').sort();
  expect(lines).toEqual(['/r/a.txt', '/r/sub/c.txt']);
}, 20000);

test('a write command without write caps is denied (EACCES → exit 1)', async () => {
  const k = await bootKernel({});
  // spawn() grants read-only caps; mkdir needs write → EACCES, command exits 1.
  const mk = await k.spawn(['mkdir', '/denied']);
  expect(mk.code).toBe(1);
  expect(await k.exists('/denied')).toBe(false);
}, 20000);

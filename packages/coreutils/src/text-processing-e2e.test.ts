/**
 * End-to-end proof for the text-processing batch (head/tail/wc/tr/rev/cut/
 * paste/uniq/sort/tee/nl/fold): each command runs as a REAL spawned process via
 * resolveCommand → kernel spawn → defineCommand → createGuest → stdio → exit, and
 * pipelines wire one command's stdout into the next's stdin.
 *
 * REQUIRES the package to be built first (`npm run build -w @mithic/coreutils`)
 * so `dist/commands/<name>.js` exists — the resolver hands the kernel those URLs.
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from './index.ts';

const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];

async function bootKernel(files: Record<string, string>): Promise<{
  spawn: (args: string[]) => Promise<{ stdout: string; code: number }>;
  pipeline: (stages: string[][]) => Promise<{ stdout: string; codes: number[] }>;
  read: (path: string) => Promise<string>;
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
    async spawn(args) {
      const code = resolveCommand(args[0], '/', {})!;
      const { pid, stdout } = await kernel.spawn(code, { args, capabilities: FS_RW, captureStdout: true });
      const { code: exitCode } = await kernel.wait(pid);
      const bytes = stdout ? await stdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), code: exitCode };
    },
    async pipeline(stages) {
      const result = await kernel.runPipeline(
        stages.map((args, i) => ({
          code: resolveCommand(args[0], '/', {})!,
          args,
          capabilities: FS_RW,
          captureStdout: i === stages.length - 1,
        })),
      );
      const bytes = result.lastStdout ? await result.lastStdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), codes: result.exitCodes };
    },
    async read(path) {
      const handle = await fs.open(path, {});
      const chunks: Uint8Array[] = [];
      let off = 0;
      for (;;) {
        const c = await fs.read(handle, off, 65536);
        if (!c || c.byteLength === 0) break;
        chunks.push(c.slice()); off += c.byteLength;
      }
      await fs.close(handle);
      let total = 0; for (const c of chunks) total += c.byteLength;
      const buf = new Uint8Array(total); let p = 0;
      for (const c of chunks) { buf.set(c, p); p += c.byteLength; }
      return new TextDecoder().decode(buf);
    },
  };
}

test('sort <file> sorts as a real spawned process', async () => {
  const k = await bootKernel({ '/words.txt': 'banana\napple\ncherry\n' });
  const out = await k.spawn(['sort', '/words.txt']);
  expect(out.stdout).toBe('apple\nbanana\ncherry\n');
  expect(out.code).toBe(0);
}, 20000);

test('wc -l <file> counts lines end-to-end', async () => {
  const k = await bootKernel({ '/n.txt': 'a\nb\nc\n' });
  const out = await k.spawn(['wc', '-l', '/n.txt']);
  // GNU: a single count field from a single source prints with no padding.
  expect(out.stdout).toBe('3 /n.txt\n');
  expect(out.code).toBe(0);
}, 20000);

test('pipeline cat | sort | uniq -c collapses and counts', async () => {
  const k = await bootKernel({ '/d.txt': 'b\na\nb\na\nb\n' });
  const out = await k.pipeline([['cat', '/d.txt'], ['sort'], ['uniq', '-c']]);
  expect(out.stdout).toBe('      2 a\n      3 b\n');
  expect(out.codes).toEqual([0, 0, 0]);
}, 20000);

test('pipeline cat | head -n 2 | tr a-z A-Z', async () => {
  const k = await bootKernel({ '/t.txt': 'one\ntwo\nthree\n' });
  const out = await k.pipeline([['cat', '/t.txt'], ['head', '-n', '2'], ['tr', 'a-z', 'A-Z']]);
  expect(out.stdout).toBe('ONE\nTWO\n');
  expect(out.codes).toEqual([0, 0, 0]);
}, 20000);

test('tee writes piped stdin to a file AND stdout as a real process', async () => {
  // cat <file> feeds tee real bytes; tee must echo to stdout and persist the file.
  const k = await bootKernel({ '/src.txt': 'teed content\n' });
  const out = await k.pipeline([['cat', '/src.txt'], ['tee', '/sink.txt']]);
  expect(out.stdout).toBe('teed content\n');
  expect(out.codes[out.codes.length - 1]).toBe(0);
  expect(await k.read('/sink.txt')).toBe('teed content\n');
}, 20000);

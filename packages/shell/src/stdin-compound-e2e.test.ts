/**
 * Regression capstone for compound-statement `< file` stdin redirects
 * (byte-stream stdin, Task 3). A COMPOUND statement (`{ …; }`, `while`, `for`,
 * subshell) that carries a `< file` redirect must install that file as the
 * frame's stdin stream so the inner `read`/`cat`/… builtins consume it over one
 * shared cursor. Before the fix, `applyRedirects` `continue`d past input
 * redirects, so the compound body fell through to the never-written live root
 * stdin and HUNG.
 *
 * Each test has a per-test timeout so a regression FAILS (times out) instead of
 * hanging the whole suite. REQUIRES all packages built (`npm run build`).
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';

/**
 * Boot a real Kernel + WorkerRuntime + coreutils resolver over a MemoryFs seeded
 * with `/data.txt` = `seed`, run `script`, and return captured stdout as text.
 */
async function run(script: string, seed = 'alpha\nbeta\ngamma\n'): Promise<string> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);
  const fs = new MemoryFsProvider({ files: {} });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  const h = fs.open('/data.txt', { write: true, create: true });
  fs.write(h, new TextEncoder().encode(seed), 0);
  fs.close(h);

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const { pid, stdout } = await kernel.spawn(new URL('../dist/process.js', import.meta.url), {
    args: ['bash', '-c', script],
    capabilities: [{ type: 'process' }, { type: 'fs', paths: ['/'], operations: ['read', 'write'] }],
    captureStdout: true,
  });
  await kernel.wait(pid);
  return new TextDecoder().decode(stdout ? await stdout : new Uint8Array());
}

test('while read line; do …; done < file streams all lines (no hang)', async () => {
  expect(await run('while read l; do echo "got:$l"; done < /data.txt'))
    .toBe('got:alpha\ngot:beta\ngot:gamma\n');
}, 15000);

test('{ read a; read b; } < file advances the cursor (no hang)', async () => {
  expect((await run('{ read a; read b; } < /data.txt; echo "$a|$b"')).trim()).toBe('alpha|beta');
}, 15000);

test('pipe into while read streams (no OOM/hang)', async () => {
  expect(await run('printf "one\\ntwo\\nthree\\n" | while read l; do echo "L=$l"; done'))
    .toBe('L=one\nL=two\nL=three\n');
}, 15000);

test('for loop body reads from a < redirect on the loop', async () => {
  expect((await run('for i in 1 2; do read x; echo "$i:$x"; done < /data.txt')).trim())
    .toBe('1:alpha\n2:beta');
}, 15000);

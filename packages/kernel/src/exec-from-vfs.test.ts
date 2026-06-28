import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/**
 * Exec-from-VFS (RFC 0001 §4.2, Task S2): an absolute VFS path is no longer
 * forwarded to the launcher as a host-module specifier. The kernel reads the
 * file's bytes, requires the execute bit (`mode & 0o111`, else EACCES), strips a
 * leading `#!` line, and runs the result as guest source.
 */

// A `#!/bin/node` guest that echoes `hello from <argv0-basename>` to stdout.
const HELLO_SRC = `#!/bin/node
import { createGuest } from '@mithic/guest-runtime';
export default async (boot) => {
  const g = createGuest(boot);
  const name = (g.args[0] ?? '').split('/').pop();
  const w = g.stdout.getWriter();
  await w.write(new TextEncoder().encode('hello from ' + name));
  await w.close();
  g.exit(0);
};`;

async function makeKernel(): Promise<{ kernel: Kernel; vfs: FileSystemRouter }> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  return { kernel, vfs };
}

async function writeFile(vfs: FileSystemRouter, path: string, contents: string): Promise<void> {
  // Ensure the parent directory exists (mkdir is idempotent enough for /usr/bin).
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) {
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      try { await vfs.mkdir(cur); } catch { /* already exists */ }
    }
  }
  const fh = await vfs.open(path, { create: true, write: true, truncate: true });
  await vfs.write(fh, new TextEncoder().encode(contents), 0);
  await vfs.close(fh);
}

test('S2: spawning a +x VFS path sources the guest bytes and runs it', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/usr/bin/hello', HELLO_SRC);
  await vfs.chmod('/usr/bin/hello', 0o755);

  const { pid, stdout } = await kernel.spawn('/usr/bin/hello', {
    args: ['/usr/bin/hello'],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello from hello');
}, 20000);

test('S2: spawning a VFS path WITHOUT the execute bit fails EACCES', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/usr/bin/noexec', HELLO_SRC); // default mode 0o644, no +x

  await expect(
    kernel.spawn('/usr/bin/noexec', { args: ['/usr/bin/noexec'], captureStdout: true }),
  ).rejects.toMatchObject({ errno: 'EACCES' });
}, 20000);

test('S2: spawning a non-existent VFS path fails ENOENT', async () => {
  const { kernel } = await makeKernel();
  await expect(
    kernel.spawn('/usr/bin/ghost', { args: ['/usr/bin/ghost'], captureStdout: true }),
  ).rejects.toMatchObject({ errno: 'ENOENT' });
}, 20000);

test('S2: a guest sourced from VFS runs even when its file has no leading shebang', async () => {
  const { kernel, vfs } = await makeKernel();
  const noShebang = HELLO_SRC.slice(HELLO_SRC.indexOf('\n') + 1); // drop the `#!/bin/node` line
  await writeFile(vfs, '/usr/bin/plain', noShebang);
  await vfs.chmod('/usr/bin/plain', 0o755);

  const { pid, stdout } = await kernel.spawn('/usr/bin/plain', {
    args: ['/usr/bin/plain'],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello from plain');
}, 20000);

test('S2: a non-path host-module string spawn is unchanged (inline source still runs)', async () => {
  const { kernel } = await makeKernel();
  const { pid, stdout } = await kernel.spawn(HELLO_SRC.slice(HELLO_SRC.indexOf('\n') + 1), {
    args: ['inline'],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello from inline');
}, 20000);

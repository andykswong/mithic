import { test, expect } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

async function writeFile(vfs: FileSystemRouter, path: string, contents: string): Promise<void> {
  // Ensure the parent directory exists (mkdir is idempotent enough for /home).
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

const FAKE_DEP = /* js */`
  export function createGuest(boot) {
    return {
      pid: boot.init.pid,
      args: boot.init.args,
      writeStdout(bytes) { boot.preopenPorts[1]?.postMessage({ type: 'data', chunk: bytes }); },
      closeStdout() { boot.preopenPorts[1]?.postMessage({ type: 'end' }); },
      exit(code) { boot.control.postMessage({ type: 'exit', code }); boot.control.close(); },
    };
  }
`;

const GUEST = /* js */`#!/bin/node
export default async (boot) => {
  const { createGuest } = await import(boot.imports['@mithic/guest-runtime']);
  const g = createGuest(boot);
  g.writeStdout(new TextEncoder().encode('hi ' + (g.args[1] ?? '') + '\\n'));
  g.closeStdout();
  g.exit(0);
};
`;

test('kernel + Worker: ESM guest exec-d from a VFS path imports a dep via boot.imports', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await writeFile(vfs, '/home/greet', GUEST);
  await vfs.chmod('/home/greet', 0o755);
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, guestImports: { '@mithic/guest-runtime': FAKE_DEP } });
  const { pid, stdout } = await kernel.spawn('/home/greet', { args: ['greet', 'world'], capabilities: [], captureStdout: true });
  const result = await kernel.wait(pid);
  expect(result.code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hi world\n');
}, 20000);

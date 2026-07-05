import { test } from 'node:test';
import assert from 'node:assert';
import { Kernel } from './kernel.ts';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';

async function writeFile(vfs: FileSystemRouter, path: string, contents: string): Promise<void> {
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

const DEP = `export function createGuest(boot) {
  return {
    args: boot.init.args,
    stdout: { getWriter() { return { write(b){ boot.preopenPorts[1]?.postMessage({ type:'data', chunk:b }); return Promise.resolve(); }, close(){ boot.preopenPorts[1]?.postMessage({ type:'end' }); return Promise.resolve(); } }; } },
    exit(code){ boot.control.postMessage({ type:'exit', code }); boot.control.close(); },
  };
}`;

const GUEST = `#!/bin/node
export default async (boot) => {
  const { createGuest } = await import(boot.imports['@mithic/guest-runtime']);
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  await w.write(new TextEncoder().encode('node-ok ' + (g.args[1] ?? '')));
  await w.close();
  g.exit(0);
};`;

test('Node in-process launcher populates boot.imports with resolvable URLs (non-Vite §6.1)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await writeFile(vfs, '/usr/bin/greet', GUEST);
  await vfs.chmod('/usr/bin/greet', 0o755);
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, guestImports: { '@mithic/guest-runtime': DEP } });
  const { pid, stdout } = await kernel.spawn('greet', { args: ['greet', 'world'], env: { PATH: '/usr/bin' }, capabilities: [], captureStdout: true });
  await kernel.wait(pid);
  assert.strictEqual(new TextDecoder().decode(await stdout!), 'node-ok world');
});

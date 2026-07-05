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

// §4.4 zero-dep: a guest with NO deps in guestImports must still see boot.imports as
// a present, empty object (the always-present invariant). This guest self-reports it
// over its own stdout write port (no createGuest dep needed).
const ZERO_DEP_GUEST = `#!/bin/node
export default async (boot) => {
  const ok = boot.imports && typeof boot.imports === 'object' && Object.keys(boot.imports).length === 0;
  const text = ok ? 'imports-ok:' + Object.keys(boot.imports).length : 'imports-BAD';
  boot.preopenPorts[1]?.postMessage({ type: 'data', chunk: new TextEncoder().encode(text) });
  boot.preopenPorts[1]?.postMessage({ type: 'end' });
  boot.control.postMessage({ type: 'exit', code: 0 });
  boot.control.close();
};`;

test('§4.4: a zero-dep guest sees boot.imports present and empty (Kernel without guestImports)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await writeFile(vfs, '/usr/bin/zero', ZERO_DEP_GUEST);
  await vfs.chmod('/usr/bin/zero', 0o755);
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs }); // no guestImports → {}
  const { pid, stdout } = await kernel.spawn('zero', { args: ['zero'], env: { PATH: '/usr/bin' }, capabilities: [], captureStdout: true });
  await kernel.wait(pid);
  assert.strictEqual(new TextDecoder().decode(await stdout!), 'imports-ok:0');
});

// §4.2/§4.3: a ?bundle IIFE guest has NO `export default` — esbuild drops it and instead
// sets `globalThis.__mithic_default` in a top-level footer. Both browser bootstraps resolve
// the entrypoint as `mod.default ?? globalThis.__mithic_default`; the Node in-process
// launcher MUST honor the same contract or an IIFE guest crashes on Node while running on
// Worker/iframe. This guest writes directly to its stdout port (no createGuest dep needed).
const IIFE_GUEST = `#!/bin/node
globalThis.__mithic_default = async (boot) => {
  boot.preopenPorts[1]?.postMessage({ type: 'data', chunk: new TextEncoder().encode('iife-node-ok') });
  boot.preopenPorts[1]?.postMessage({ type: 'end' });
  boot.control.postMessage({ type: 'exit', code: 0 });
  boot.control.close();
};`;

test('§4.2/§4.3: an IIFE guest (globalThis.__mithic_default, no export default) runs on Node', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await writeFile(vfs, '/usr/bin/iife', IIFE_GUEST);
  await vfs.chmod('/usr/bin/iife', 0o755);
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  const { pid, stdout } = await kernel.spawn('iife', { args: ['iife'], env: { PATH: '/usr/bin' }, capabilities: [], captureStdout: true });
  await kernel.wait(pid);
  assert.strictEqual(new TextDecoder().decode(await stdout!), 'iife-node-ok');
});

// §6.1 fail-loud negative: a guest importing a MISSING dep does `import(undefined)`,
// which throws. The in-process launcher's fire-and-forget catch swallows the crash,
// so the guest never writes stdout and never exits (wait + capture both hang forever).
// The honest, observable fail-loud behavior on this path is: the SUCCESS output never
// appears. Race a bounded window so the test terminates cleanly instead of hanging.
const MISSING_DEP_GUEST = `#!/bin/node
export default async (boot) => {
  const { createGuest } = await import(boot.imports['not-there']);
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  await w.write(new TextEncoder().encode('SHOULD-NOT-APPEAR'));
  await w.close();
  g.exit(0);
};`;

test('§6.1 fail-loud: a guest importing a MISSING dep never produces its success output', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await writeFile(vfs, '/usr/bin/boom', MISSING_DEP_GUEST);
  await vfs.chmod('/usr/bin/boom', 0o755);
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, guestImports: { '@mithic/guest-runtime': DEP } });
  const { stdout } = await kernel.spawn('boom', { args: ['boom'], env: { PATH: '/usr/bin' }, capabilities: [], captureStdout: true });
  // import(undefined) throws → the guest never writes → the capture never settles.
  // Assert the crash is fail-loud: no success output within a bounded window.
  const HANG = Symbol('hang');
  const result = await Promise.race([
    stdout!.then((b) => new TextDecoder().decode(b)),
    new Promise<typeof HANG>((res) => setTimeout(() => res(HANG), 2000)),
  ]);
  assert.strictEqual(result, HANG); // crashed silently: no 'SHOULD-NOT-APPEAR', no EOF
});

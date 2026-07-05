import { test, expect } from 'vitest';
import guestRuntimeDep from '../../../guest-runtime/src/index.ts?bundle-esm';
import { Kernel } from '@mithic/kernel';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { createCommandSuite } from './commands.ts';

// FileSystemRouter has no writeFile; mirror the exec-from-vfs.test.ts install idiom.
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

// An ESM exec-from-VFS guest that imports the REAL @mithic/guest-runtime through
// `boot.imports` (G2), not a bare specifier — proving the injected dep bytes boot it.
const GUEST = /* js */`#!/bin/node
export default async (boot) => {
  const { createGuest } = await import(boot.imports['@mithic/guest-runtime']);
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  await w.write(new TextEncoder().encode('hi ' + (g.args[1] ?? '') + '\\n'));
  await w.close();
  g.exit(0);
};
`;

for (const [name, makeRt] of [['worker', () => new WorkerRuntime()], ['iframe', () => new IframeRuntime()]] as const) {
  test(`Lab OF1 (${name}): ESM guest importing real @mithic/guest-runtime runs byte-exact`, async () => {
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    await writeFile(vfs, '/usr/bin/greet', GUEST);
    await vfs.chmod('/usr/bin/greet', 0o755);
    const kernel = new Kernel({ runtime: makeRt(), vfs, guestImports: { '@mithic/guest-runtime': guestRuntimeDep } });
    const { pid, stdout } = await kernel.spawn('greet', { args: ['greet', 'world'], env: { PATH: '/usr/bin' }, capabilities: [], captureStdout: true });
    await kernel.wait(pid);
    expect(new TextDecoder().decode(await stdout!)).toBe('hi world\n');
  }, 20000);
}

/**
 * The Lab's real launcher is InProcessCommandLauncher (commands.ts): a registered
 * `command:<name>` sentinel boots in-process; ANY other code (exec-from-VFS guest
 * source) is delegated to a DefaultGuestLauncher. This drives the REAL launcher (not
 * only a bare DefaultGuestLauncher) so the delegation path — which must thread
 * guestImports for a dep-bearing ESM guest to resolve its dep — is covered (§8).
 */
test('Lab OF1: an exec-from-VFS ESM guest runs under the REAL InProcessCommandLauncher with guestImports', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await writeFile(vfs, '/usr/bin/greet', GUEST);
  await vfs.chmod('/usr/bin/greet', 0o755);
  const suite = createCommandSuite();
  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    resolveCommand: (name) => suite.resolve(name),
    launcher: suite.launcher,
    guestImports: { '@mithic/guest-runtime': guestRuntimeDep },
  });
  const { pid, stdout } = await kernel.spawn('greet', { args: ['greet', 'lab'], env: { PATH: '/usr/bin' }, capabilities: [], captureStdout: true });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('hi lab\n');
}, 20000);

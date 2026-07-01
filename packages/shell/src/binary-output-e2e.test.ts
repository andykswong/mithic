/**
 * Integration capstone for the byte-safe output sink: a binary VFS file `cat`ted
 * through the REAL shell must reach captured stdout byte-exact. This exercises
 * every guest→shell output boundary (executor's writeCaptured / pumpToStdout) AND
 * the shell guest entry's root sink (process.ts), all wired to `writeBytes` so no
 * UTF-8 round-trip corrupts the raw bytes.
 *
 * REQUIRES all packages built (`npm run build`) — the resolver imports each
 * command's dist module and spawns the shell's `dist/process.js`.
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';

// 0x00 0xFF 0xFE are NOT valid standalone UTF-8. `cat /bin.dat` through the real
// shell must reach captured stdout byte-exact (no UTF-8 replacement).
test('cat of a binary VFS file round-trips byte-exact through the shell', async () => {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);
  const fs = new MemoryFsProvider({ files: {} });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  // Write raw bytes into the VFS via the provider's real open/write/close API:
  // open(path, flags) → FileHandle, write(handle, data, offset) → byteCount, close(handle).
  const h = fs.open('/bin.dat', { write: true, create: true });
  fs.write(h, new Uint8Array([0x00, 0xff, 0xfe]), 0);
  fs.close(h);

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const guestUrl = new URL('../dist/process.js', import.meta.url);
  const { pid, stdout } = await kernel.spawn(guestUrl, {
    args: ['bash', '-c', 'cat /bin.dat'],
    capabilities: [{ type: 'process' }, { type: 'fs', paths: ['/'], operations: ['read', 'write'] }],
    captureStdout: true,
  });
  await kernel.wait(pid);
  const bytes = stdout ? await stdout : new Uint8Array();
  expect(Array.from(bytes)).toEqual([0x00, 0xff, 0xfe]);
}, 30000);

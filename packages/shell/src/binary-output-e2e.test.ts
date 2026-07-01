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

/**
 * Boot a real Kernel + WorkerRuntime + coreutils resolver over a MemoryFs seeded
 * with `/bin.dat` = the given bytes, run `script`, and return captured stdout.
 */
async function bootAndRun(bytes: number[], script: string): Promise<Uint8Array> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);
  const fs = new MemoryFsProvider({ files: {} });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  // Write raw bytes into the VFS via the provider's real (synchronous) API:
  // open(path, flags) → FileHandle, write(handle, data, offset) → byteCount, close(handle).
  const h = fs.open('/bin.dat', { write: true, create: true });
  fs.write(h, new Uint8Array(bytes), 0);
  fs.close(h);

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const guestUrl = new URL('../dist/process.js', import.meta.url);
  const { pid, stdout } = await kernel.spawn(guestUrl, {
    args: ['bash', '-c', script],
    capabilities: [{ type: 'process' }, { type: 'fs', paths: ['/'], operations: ['read', 'write'] }],
    captureStdout: true,
  });
  await kernel.wait(pid);
  return stdout ? await stdout : new Uint8Array();
}

// 0x00 0xFF 0xFE are NOT valid standalone UTF-8. `cat /bin.dat` through the real
// shell must reach captured stdout byte-exact (no UTF-8 replacement).
test('cat of a binary VFS file round-trips byte-exact through the shell', async () => {
  const bytes = await bootAndRun([0x00, 0xff, 0xfe], 'cat /bin.dat');
  expect(Array.from(bytes)).toEqual([0x00, 0xff, 0xfe]);
}, 30000);

// `> /dev/stdout` resolves to the shell's (now byte-safe) stdout sink; the bytes
// must stay byte-exact rather than round-trip through UTF-8 at the device sink.
test('cat of a binary file redirected to /dev/stdout stays byte-exact', async () => {
  const bytes = await bootAndRun([0x00, 0xff, 0xfe], 'cat /bin.dat > /dev/stdout');
  expect(Array.from(bytes)).toEqual([0x00, 0xff, 0xfe]);
}, 30000);

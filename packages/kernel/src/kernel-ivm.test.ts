/**
 * H3 — functional isolated-vm backend as a Kernel backend.
 *
 * Previously IvmRuntime.spawn awaited context.eval() to completion before
 * returning and the __mithic_syscall Callback was fire-and-forget, so no syscall
 * could ever be serviced; and there was no IvmRelayLauncher (directPipes=false
 * forces the relay path). Now:
 *   - IvmRuntime starts the isolate non-blocking with a SUSPENDABLE async syscall
 *     bridge (applySyncPromise round-trip) that returns results into the isolate.
 *   - IvmRelayLauncher mirrors the QuickJS relay launcher so a Kernel can run with
 *     IvmRuntime: the guest's __mithic_syscall(call,args) is serviced in-kernel.
 *   - cpuLimit is enforced via an isolate.cpuTime watchdog.
 *
 * Gated with isIvmAvailable(): skipped if the native addon can't load.
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { isIvmAvailable, IvmRuntime } from '@mithic/runtime/backends/ivm';
import { IvmRelayLauncher } from './launchers/ivm-relay-launcher.ts';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

const ivmAvailable = await isIvmAvailable();

test.skipIf(!ivmAvailable)(
  'H3: a Kernel running IvmRuntime services a guest syscall round-trip and writes stdout',
  async () => {
    const rt = await IvmRuntime.create(64);
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    const kernel = new Kernel({ runtime: rt, vfs, relayLauncher: new IvmRelayLauncher(rt) });

    // The guest performs a SERVICED syscall (process/getpid) — proving the bridge
    // returns a real result into the isolate — then writes it to stdout and exits.
    // isolated-vm has Uint8Array but no TextEncoder; pass a string to pipe/write.
    const code = `
      const r = __mithic_syscall('process/getpid', {});
      __mithic_syscall('pipe/write', { fd: 1, data: 'pid=' + r.pid });
      __mithic_syscall('process/exit', { code: 0 });
    `;
    const { pid, stdout } = await kernel.spawn(code, { args: ['prog'], capabilities: [], captureStdout: true });
    const result = await kernel.wait(pid);
    expect(result.code).toBe(0);
    // The serviced getpid returned the kernel-owned pid (the bridge round-tripped).
    expect(new TextDecoder().decode(await stdout!)).toBe('pid=' + pid);
  },
  20000,
);

test.skipIf(!ivmAvailable)(
  'H3: a capability-gated fs syscall is denied in-kernel for an ivm relay guest (EACCES)',
  async () => {
    const rt = await IvmRuntime.create(64);
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    await vfs.mkdir('/secret');
    const kernel = new Kernel({ runtime: rt, vfs, relayLauncher: new IvmRelayLauncher(rt) });

    const code = `
      let result;
      try { __mithic_syscall('fs/stat', { path: '/secret/k.txt' }); result = 'NO_ERROR'; }
      catch (e) { result = String((e && e.code) || '') + ':' + String((e && e.message) || e); }
      __mithic_syscall('pipe/write', { fd: 1, data: result });
      __mithic_syscall('process/exit', { code: 0 });
    `;
    const { pid, stdout } = await kernel.spawn(code, {
      args: ['prog'],
      capabilities: [{ type: 'fs', paths: ['/allowed'], operations: ['read'] }],
      captureStdout: true,
    });
    await kernel.wait(pid);
    const out = new TextDecoder().decode(await stdout!);
    expect(out).toContain('EACCES');
    expect(out).not.toContain('NO_ERROR');
  },
  20000,
);

test.skipIf(!ivmAvailable)(
  'H3: cpuLimit aborts a CPU-bound infinite loop (cpuMs enforced)',
  async () => {
    const rt = await IvmRuntime.create(64);
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    const kernel = new Kernel({ runtime: rt, vfs, relayLauncher: new IvmRelayLauncher(rt) });

    // A tight infinite loop that never yields — only a cpuTime watchdog stops it.
    const code = 'let x = 0; for (;;) { x++; }';
    const t0 = Date.now();
    const { pid } = await kernel.spawn(code, { args: ['spin'], capabilities: [], limits: { cpuMs: 200 } });
    const result = await Promise.race([
      kernel.wait(pid),
      new Promise<{ code: number }>((_, rej) => setTimeout(() => rej(new Error('cpuLimit watchdog never fired (H3)')), 8000)),
    ]);
    const elapsed = Date.now() - t0;
    expect(result.code).toBe(137); // CPU-limit kill → exit 137 (ivm.ts:211 marks it; kernel passes it through)
    expect(elapsed).toBeLessThan(6000);
  },
  12000,
);

test('H3: IvmRuntime advertises cpuLimit + a relay launcher exists (compile-time wiring)', async () => {
  // This always runs (no native addon needed) to prove the API surface exists:
  // IvmRelayLauncher is exported and IVM_CAPABILITIES advertise the enforced limits.
  const { IVM_CAPABILITIES } = await import('@mithic/runtime');
  expect(IVM_CAPABILITIES.directPipes).toBe(false);
  expect(IVM_CAPABILITIES.memoryLimit).toBe(true);
  expect(IVM_CAPABILITIES.cpuLimit).toBe(true);
  expect(typeof IvmRelayLauncher).toBe('function');
});

test.skipIf(!ivmAvailable)('kernel relay: ivm guest reads fd-0 stdin (bytes source)', async () => {
  const ivmRt = await IvmRuntime.create(64);
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: ivmRt, vfs, relayLauncher: new IvmRelayLauncher(ivmRt) });

  const code = `
    let out = '';
    for (;;) { const r = __mithic_syscall('pipe/read', { fd: 0 }); const d = r&&r.data?r.data:[]; if(!d.length)break; out += String.fromCharCode.apply(null, d); }
    __mithic_syscall('pipe/write', { fd: 1, data: 'ivm:' + out });
    __mithic_syscall('process/exit', { code: 0 });
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'], capabilities: [], captureStdout: true,
    fds: { 0: { action: 'bytes', data: new TextEncoder().encode('xyz') } },
  });
  expect((await kernel.wait(pid)).code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('ivm:xyz');
}, 15000);

/**
 * BYTE-LOSS REGRESSION (ivm): the ivm bridge serializes syscall args/results via
 * JSON.stringify/parse, which mangles a Uint8Array to `{0:..}` in BOTH directions
 * (fs/write args + fs/read result). The guest writes non-UTF8 bytes (0x00, 0x7F,
 * 0x80, 0xFF plus a multi-byte UTF-8 sequence) to a MemoryFsProvider file, reads
 * them back, and echoes the byte VALUES as a comma-joined string for a byte-exact,
 * encoding-independent assertion.
 */
test.skipIf(!ivmAvailable)('kernel relay: ivm fs/write + fs/read round-trips binary bytes byte-exact', async () => {
  const ivmRt = await IvmRuntime.create(64);
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: ivmRt, vfs, relayLauncher: new IvmRelayLauncher(ivmRt) });

  const bytes = [0, 0x7f, 0x80, 0xff, 0xe2, 0x82, 0xac, 65];

  const code = `
    const bytes = new Uint8Array([${bytes.join(',')}]);
    const { fd } = __mithic_syscall('fs/open', { path: '/bin.dat', oflags: { create: true, write: true, truncate: true } });
    __mithic_syscall('fs/write', { fd, data: bytes, offset: 0 });
    __mithic_syscall('fs/close', { fd });
    const { fd: rfd } = __mithic_syscall('fs/open', { path: '/bin.dat', oflags: { read: true } });
    const r = __mithic_syscall('fs/read', { fd: rfd, len: 4096 });
    const data = Array.isArray(r) ? r : (r && r.data ? r.data : (r && typeof r === 'object' ? Object.keys(r).map(function(k){return r[k];}) : []));
    __mithic_syscall('fs/close', { fd: rfd });
    __mithic_syscall('pipe/write', { fd: 1, data: 'bytes:' + Array.prototype.join.call(data, ',') + '|isArray:' + Array.isArray(r) });
    __mithic_syscall('process/exit', { code: 0 });
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [{ type: 'fs', paths: ['/'], operations: ['read', 'write'] }],
    captureStdout: true,
  });
  expect((await kernel.wait(pid)).code).toBe(0);
  // `isArray:true` guards the READ direction independently: the ivm read serializer
  // (stringifyResponse) must deliver a real number[] to the guest. Without the fix
  // the host Uint8Array is mangled to `{0:..}` — the guest's defensive Object.keys
  // fallback would still reconstruct the byte values, so assert on the raw result
  // shape so a read-serializer revert goes RED here, not only in the dedicated
  // backend serializer test.
  expect(new TextDecoder().decode(await stdout!)).toBe('bytes:' + bytes.join(',') + '|isArray:true');
  const h = await vfs.open('/bin.dat', { read: true });
  const stored = await vfs.read(h, 0, 4096);
  await vfs.close(h);
  expect(Array.from(stored)).toEqual(bytes);
}, 20000);

/** BYTE-LOSS edge (ivm): an empty read at EOF yields zero bytes. */
test.skipIf(!ivmAvailable)('kernel relay: ivm fs/read at EOF returns an empty chunk', async () => {
  const ivmRt = await IvmRuntime.create(64);
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: ivmRt, vfs, relayLauncher: new IvmRelayLauncher(ivmRt) });

  const code = `
    const { fd } = __mithic_syscall('fs/open', { path: '/empty.dat', oflags: { create: true, write: true, truncate: true } });
    __mithic_syscall('fs/close', { fd });
    const { fd: rfd } = __mithic_syscall('fs/open', { path: '/empty.dat', oflags: { read: true } });
    const r = __mithic_syscall('fs/read', { fd: rfd, len: 4096 });
    const data = Array.isArray(r) ? r : (r && r.data ? r.data : (r && typeof r === 'object' ? Object.keys(r).map(function(k){return r[k];}) : []));
    __mithic_syscall('fs/close', { fd: rfd });
    __mithic_syscall('pipe/write', { fd: 1, data: 'len:' + data.length });
    __mithic_syscall('process/exit', { code: 0 });
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [{ type: 'fs', paths: ['/'], operations: ['read', 'write'] }],
    captureStdout: true,
  });
  expect((await kernel.wait(pid)).code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('len:0');
}, 20000);

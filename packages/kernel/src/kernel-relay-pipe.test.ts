/**
 * K5 — kernel byte-relay for fs/pipe + ipc on non-transferable backends (§4.8).
 *
 * QuickJS guests cannot receive transferable MessagePorts, so previously fs/pipe
 * and connected ipc (accept/connect) returned ENOSYS — anonymous pipes and IPC
 * were unavailable. The kernel now BYTE-RELAYS these on the relay path: fs/pipe
 * returns fd NUMBERS (no ports); the kernel retains both pipe ends and services
 * `pipe/read {fd,len}` / `pipe/write {fd,data}` / `pipe/close {fd}` by operating
 * the kernel-held ports. Same for ipc/connect|accept connection fds.
 *
 * This drives the QuickJS backend through the relay launcher, exactly like
 * kernel-quickjs.test.ts, with the launcher forwarding pipe/read|write|close and
 * ipc/* to the kernel via ctx.onSyscall.
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import type { RelayContext, RelayLauncher } from './kernel.ts';
import type { ProcessHandle, Runtime } from '@mithic/runtime';
import { QuickJSRuntime } from '@mithic/runtime/backends/quickjs';
import type { QuickJSSpawnOptions } from '@mithic/runtime/backends/quickjs';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/**
 * QuickJS relay launcher mirroring kernel-quickjs.test.ts but routing the relay
 * byte-pipe ops (pipe/read, pipe/write, pipe/close) and ipc/* through the kernel.
 * stdout/stderr writes (fd 1/2) still short-circuit to the relay context.
 */
class QuickJSGuestLauncher implements RelayLauncher {
  #rt: QuickJSRuntime;
  constructor(rt: QuickJSRuntime) { this.#rt = rt; }

  async launchRelay(_runtime: Runtime, ctx: RelayContext): Promise<ProcessHandle> {
    const onSyscall: QuickJSSpawnOptions['onSyscall'] = async (call, args) => {
      // stdout/stderr writes short-circuit to the captured streams.
      if (call === 'pipe/write' && (Number(args['fd']) === 1 || Number(args['fd']) === 2)) {
        const raw = args['data'];
        const chunk = raw instanceof Uint8Array ? raw
          : Array.isArray(raw) ? new Uint8Array(raw as number[])
            : typeof raw === 'string' ? new TextEncoder().encode(raw)
              : new Uint8Array(0);
        if (Number(args['fd']) === 1) ctx.writeStdout(chunk); else ctx.writeStderr(chunk);
        return { written: chunk.byteLength };
      }
      if (call === 'process/exit') {
        ctx.closeStdout(); ctx.closeStderr(); ctx.notifyExit(Number(args['code'] ?? 0));
        return {};
      }
      if (call === 'process/getpid') return { pid: ctx.init.pid };
      // Everything else (fs/pipe, pipe/read, pipe/write to a relay fd, pipe/close,
      // ipc/*) is KERNEL-routed; the kernel owns the pid + ports.
      const res = await ctx.onSyscall(call, args);
      if (res.ok) return res.result as Record<string, unknown>;
      throw new Error(`${res.error.code}: ${res.error.message}`);
    };
    const handle = await this.#rt.spawn(ctx.code, { init: ctx.init, onSyscall });
    this.#rt.waitExit(handle).then(({ code }) => {
      ctx.closeStdout(); ctx.closeStderr(); ctx.notifyExit(code);
    }).catch(() => ctx.notifyExit(1));
    return handle;
  }
}

test('K5: a QuickJS guest uses fs/pipe (byte-relay): writes to writefd, reads from readfd', async () => {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: qjsRt, vfs, relayLauncher: new QuickJSGuestLauncher(qjsRt) });

  // The guest mints a pipe, writes "ping-pong" into writefd, closes it, then reads
  // all of readfd and echoes what it read to stdout. No MessagePorts involved.
  // NOTE: QuickJS has no TextDecoder/TextEncoder — pass strings to pipe/write (the
  // kernel encodes them) and rebuild read bytes via String.fromCharCode (ASCII).
  const code = `
    const p = __mithic_syscall('fs/pipe', {});
    __mithic_syscall('pipe/write', { fd: p.writefd, data: 'ping-pong' });
    __mithic_syscall('pipe/close', { fd: p.writefd });
    let out = '';
    for (;;) {
      const r = __mithic_syscall('pipe/read', { fd: p.readfd, len: 4 });
      if (!r.data || r.data.length === 0) break;
      out += String.fromCharCode.apply(null, r.data);
    }
    __mithic_syscall('pipe/write', { fd: 1, data: out });
    __mithic_syscall('process/exit', { code: 0 });
  `;
  const { pid, stdout } = await kernel.spawn(code, { args: ['prog'], capabilities: [], captureStdout: true });
  const result = await kernel.wait(pid);
  expect(result.code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('ping-pong');
}, 20000);

test('K5: a QuickJS guest uses connected IPC (ipc/listen + connect + accept) via byte-relay', async () => {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: qjsRt, vfs, relayLauncher: new QuickJSGuestLauncher(qjsRt) });

  // One guest both listens AND connects to its own channel (single-process loopback),
  // accepts the connection, writes a message on the connect side, reads it on the
  // accept side. Proves ipc connect/accept return relay fds the guest can byte-relay.
  const code = `
    const L = __mithic_syscall('ipc/listen', { path: 'chan/x' });
    const C = __mithic_syscall('ipc/connect', { path: 'chan/x' });
    const A = __mithic_syscall('ipc/accept', { fd: L.fd });
    __mithic_syscall('pipe/write', { fd: C.connfd, data: 'hi-peer' });
    __mithic_syscall('pipe/close', { fd: C.connfd });
    let out = '';
    for (;;) {
      const r = __mithic_syscall('pipe/read', { fd: A.connfd, len: 16 });
      if (!r.data || r.data.length === 0) break;
      out += String.fromCharCode.apply(null, r.data);
    }
    __mithic_syscall('pipe/write', { fd: 1, data: out });
    __mithic_syscall('process/exit', { code: 0 });
  `;
  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [{ type: 'ipc', channels: ['chan/x'] }],
    captureStdout: true,
  });
  const result = await kernel.wait(pid);
  expect(result.code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hi-peer');
}, 20000);

test('K5: pipe/read on an unknown relay fd returns EBADF', async () => {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: qjsRt, vfs, relayLauncher: new QuickJSGuestLauncher(qjsRt) });

  const code = `
    let result;
    try { __mithic_syscall('pipe/read', { fd: 999, len: 4 }); result = 'NO_ERROR'; }
    catch (e) { result = String(e.message || e); }
    __mithic_syscall('pipe/write', { fd: 1, data: result });
    __mithic_syscall('process/exit', { code: 0 });
  `;
  const { pid, stdout } = await kernel.spawn(code, { args: ['prog'], capabilities: [], captureStdout: true });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toContain('EBADF');
}, 20000);

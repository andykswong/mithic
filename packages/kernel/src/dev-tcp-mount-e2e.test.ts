/**
 * Seam 3 — /dev/tcp mount reachable end-to-end (net cluster).
 *
 * The net cluster shipped the io-side half (`mountNetworkDevices` +
 * `netOriginsToAllow` + `NetworkDeviceFsProvider`) and the shell shipped the
 * `exec 3<>/dev/tcp/host/port` half, but nothing MOUNTED the network devices in
 * the actual VFS the kernel runs over, so the path was unreachable.
 *
 * This proves the complete wire end-to-end against a REAL loopback TCP echo
 * server: a VFS built with `mountNetworkDevices(..., { allow: netOriginsToAllow(...) })`,
 * handed to `new Kernel({ vfs })`, lets a guest that holds BOTH gates open
 * `/dev/tcp/<host>/<port>` via `fs/open`, write+read round-trip on the returned
 * fd, and close — while denying a guest that lacks either gate:
 *
 *   GATE 1 (kernel `fs` capability on the `/dev/tcp` subtree): per-process. A
 *     guest without an `fs` grant covering `/dev/tcp` is rejected by the kernel
 *     BEFORE the provider is touched (no socket side-effect).
 *   GATE 2 (provider net-origin allowlist, derived from the host's `net`
 *     capability origins via `netOriginsToAllow`): a host:port NOT on the
 *     allowlist is rejected by the provider with `access` BEFORE any connect.
 *
 * Two independent gates, deny-by-default — no ungated networking.
 *
 * REQUIRES `npm run build` first (the inline guests import `@mithic/guest-runtime`).
 */
import { expect, test, afterEach } from 'vitest';
import * as net from 'node:net';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import {
  FileSystemRouter,
  MemoryFsProvider,
  DeviceFsProvider,
  mountNetworkDevices,
  netOriginsToAllow,
} from '@mithic/io/vfs';
import { NodeSocketProvider } from '@mithic/io/net/providers/node-socket-provider';
import type { Capability } from '@mithic/protocol';

/** Start a loopback TCP echo server; returns its port + a stop() to close it. */
function startEchoServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk)); // echo
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        stop: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

const servers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

/**
 * Build a kernel whose VFS has `/dev/tcp` + `/dev/udp` mounted with a net-origin
 * allowlist (Gate 2), over Node sockets so a real loopback connection works.
 */
async function bootKernel(netOrigins: string[]): Promise<Kernel> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await vfs.mount('/dev', new DeviceFsProvider());
  // The wire: derive the device allowlist from the host's intended net origins.
  await mountNetworkDevices(vfs, {
    sockets: new NodeSocketProvider(),
    allow: netOriginsToAllow(netOrigins),
  });
  return new Kernel({ runtime: new WorkerRuntime(), vfs });
}

/**
 * An inline guest that opens `/dev/tcp/<host>/<port>`, writes `msg`, reads the
 * echo back, and writes the round-tripped bytes to stdout (or `ERR:<code>` on a
 * capability/connection failure). Proves the fd is a real bidirectional stream.
 */
function tcpClientGuest(host: string, port: number, msg: string): string {
  return `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      try {
        const { fd } = await g.syscall('fs/open', { path: '/dev/tcp/${host}/${port}', oflags: { read: true, write: true } });
        await g.syscall('fs/write', { fd, data: new TextEncoder().encode('${msg}') });
        // Read the echo (loop until we have the full message back).
        let got = new Uint8Array(0);
        while (got.byteLength < ${msg.length}) {
          const chunk = await g.syscall('fs/read', { fd, len: 1024 });
          const data = chunk instanceof Uint8Array ? chunk : (chunk && chunk.data) || new Uint8Array(0);
          if (!data || data.byteLength === 0) break;
          const merged = new Uint8Array(got.byteLength + data.byteLength);
          merged.set(got); merged.set(data, got.byteLength); got = merged;
        }
        await g.syscall('fs/close', { fd });
        await w.write(got);
      } catch (e) {
        const code = (e && (e.code || e.message)) || String(e);
        await w.write(new TextEncoder().encode('ERR:' + code));
      }
      await w.close().catch(() => {});
      g.exit(0);
    };`;
}

const FS_DEV_TCP: Capability = { type: 'fs', paths: ['/dev/tcp'], operations: ['read', 'write'] };

async function runGuest(kernel: Kernel, code: string, capabilities: Capability[]): Promise<string> {
  const { pid, stdout } = await kernel.spawn(code, { args: ['tcp'], capabilities, captureStdout: true });
  await kernel.wait(pid);
  return new TextDecoder().decode(stdout ? await stdout : new Uint8Array());
}

test('Seam 3: a guest with BOTH gates round-trips through /dev/tcp/host/port', async () => {
  const echo = await startEchoServer();
  servers.push(echo);
  const origin = `tcp://127.0.0.1:${echo.port}`;
  const kernel = await bootKernel([origin]);

  const out = await runGuest(
    kernel,
    tcpClientGuest('127.0.0.1', echo.port, 'ping'),
    // Gate 1: fs grant on /dev/tcp. Gate 2: a net cap matching the allowlist host.
    [FS_DEV_TCP, { type: 'net', origins: [origin] }],
  );
  expect(out).toBe('ping'); // the echo server returned our bytes — bidirectional fd works
}, 15000);

test('Seam 3 (Gate 1): a guest WITHOUT an fs grant on /dev/tcp is denied by the kernel', async () => {
  const echo = await startEchoServer();
  servers.push(echo);
  const origin = `tcp://127.0.0.1:${echo.port}`;
  const kernel = await bootKernel([origin]);

  // Holds the net cap but NOT the fs grant on /dev/tcp → kernel fs check rejects.
  const out = await runGuest(
    kernel,
    tcpClientGuest('127.0.0.1', echo.port, 'ping'),
    [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }, { type: 'net', origins: [origin] }],
  );
  // EACCES = a capability denial (kernel fs check), NOT a connection error.
  expect(out).toContain('ERR:EACCES');
  expect(out).not.toBe('ping');
}, 15000);

test('Seam 3 (Gate 2): a host NOT on the net-origin allowlist is denied by the provider', async () => {
  const echo = await startEchoServer();
  servers.push(echo);
  // Mount the devices with an allowlist that PERMITS a different host:port only.
  const kernel = await bootKernel(['tcp://127.0.0.1:1']);

  // Has the fs grant on /dev/tcp, but the REQUESTED host:port is not allowed.
  const out = await runGuest(
    kernel,
    tcpClientGuest('127.0.0.1', echo.port, 'ping'),
    [FS_DEV_TCP, { type: 'net', origins: [`tcp://127.0.0.1:${echo.port}`] }],
  );
  // EACCES = the provider rejected the unlisted host BEFORE any connect (no SSRF).
  expect(out).toContain('ERR:EACCES');
  expect(out).not.toBe('ping');
}, 15000);

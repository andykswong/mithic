/**
 * G9 — `/dev/tcp` THROUGH THE SHELL via `exec N<>` + `>&N` + `read -u N`.
 *
 * The net cluster proved the KERNEL-level open (`dev-tcp-mount-e2e.test.ts`): a
 * VFS with `mountNetworkDevices(..., { allow: netOriginsToAllow(origins) })`
 * handed to `new Kernel({ vfs })` lets a guest holding BOTH gates (`fs` on
 * `/dev/tcp` + a matching `net` origin) round-trip on the fd. But the SHELL-level
 * path was untested — and it was BROKEN: the shell's redirect FsClient is
 * file-oriented (open → buffer → flush on close; read drains to EOF), so
 * `exec 3<>/dev/tcp/host/port` eagerly read the socket to EOF at exec time (a
 * socket has none until the peer closes, and the first read depends on a write
 * that has not happened) → DEADLOCK.
 *
 * THE FIX (this is the bug a G9 test exposed): the shell FsClient gained an
 * optional `fsOpenDuplex(path)` that holds ONE live `fs/open {read,write}` fd
 * open across `echo >&3` / `read -u 3`; the executor routes `<>` through it when
 * present (regular-file `<>` still uses the buffered path). So the round-trip
 * works and the socket is torn down on shell exit (`closeAllFds`).
 *
 * Modeled on `dev-tcp-mount-e2e.test.ts` but driving the BUILT `@mithic/shell`
 * `dist/process.js` with a real shell script against a LOOPBACK TCP echo server.
 *
 * REQUIRES `npm run build` first (shell `dist/process.js`).
 */
import { expect, test, afterEach } from 'vitest';
import * as net from 'node:net';
import { Kernel } from '@mithic/kernel';
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
      socket.on('error', () => { /* client reset on shell exit — ignore */ });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, stop: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}

/** A free 127.0.0.1 port with NOTHING listening (for the connection-refused case). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port)); // closed → nothing listens on `port`
    });
  });
}

const servers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });

const FS_ROOT: Capability = { type: 'fs', paths: ['/'], operations: ['read', 'write'] };

/**
 * Boot a real Kernel + WorkerRuntime whose VFS has `/dev/tcp` + `/dev/udp`
 * mounted with the given net-origin allowlist (Gate 2), over Node sockets.
 * Returns a runner that drives the built shell with `bash -c <script>` under the
 * supplied capabilities.
 */
async function bootShell(netOrigins: string[]): Promise<
  (script: string, capabilities: Capability[]) => Promise<{ stdout: string; code: number }>
> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await vfs.mount('/dev', new DeviceFsProvider());
  await mountNetworkDevices(vfs, {
    sockets: new NodeSocketProvider(),
    allow: netOriginsToAllow(netOrigins),
  });

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  const guestUrl = new URL('../dist/process.js', import.meta.url);

  return async (script, capabilities) => {
    const { pid, stdout } = await kernel.spawn(guestUrl, {
      args: ['bash', '-c', script],
      capabilities,
      captureStdout: true,
    });
    const { code } = await kernel.wait(pid);
    const bytes = stdout ? await stdout : new Uint8Array();
    return { stdout: new TextDecoder().decode(bytes), code };
  };
}

// The working path: exec 3<>/dev/tcp; echo >&3; read -u 3; print it.
test('exec 3<>/dev/tcp round-trips through the shell (write >&3, read -u 3)', async () => {
  const echo = await startEchoServer();
  servers.push(echo);
  const origin = `tcp://127.0.0.1:${echo.port}`;
  const run = await bootShell([origin]);

  const script = [
    `exec 3<>/dev/tcp/127.0.0.1/${echo.port}`,
    'echo hello >&3',
    'read -u 3 reply',
    'echo "got:$reply"',
    'exec 3>&-',
  ].join('\n');
  const out = await run(script, [
    { type: 'process' },
    FS_ROOT, // covers /dev/tcp (Gate 1)
    { type: 'net', origins: [origin] }, // Gate 2 allowlist host
  ]);

  expect(out.stdout.trim()).toBe('got:hello');
  expect(out.code).toBe(0);
}, 12000);

// Denial: NO net capability → the device's allowlist is empty → provider denies.
test('shell WITHOUT a net capability is denied (no connection, non-zero exec)', async () => {
  const echo = await startEchoServer();
  servers.push(echo);
  // Boot with an EMPTY allowlist (no net origins) → deny-by-default at the provider.
  const run = await bootShell([]);

  const script = [
    `exec 3<>/dev/tcp/127.0.0.1/${echo.port}`,
    'echo "opened rc=$?"',
    'echo hello >&3',
    'read -u 3 reply',
    'echo "got:[$reply]"',
  ].join('\n');
  const out = await run(script, [
    { type: 'process' },
    FS_ROOT, // has fs (Gate 1) but no net origin on the allowlist (Gate 2 denies)
  ]);

  // The denial surfaces as a non-zero `exec` and NO round-tripped data.
  expect(out.stdout).not.toContain('got:[hello]');
  expect(out.stdout).toMatch(/opened rc=[1-9]/);
}, 12000);

// Denial: a host NOT on the allowlist (allowlist permits a different port).
test('shell against a non-allowlisted host:port is denied by the provider', async () => {
  const echo = await startEchoServer();
  servers.push(echo);
  // Allowlist permits a DIFFERENT port only → the requested echo port is denied.
  const run = await bootShell(['tcp://127.0.0.1:1']);

  const script = [
    `exec 3<>/dev/tcp/127.0.0.1/${echo.port}`,
    'echo "opened rc=$?"',
    'echo hello >&3',
    'read -u 3 reply',
    'echo "got:[$reply]"',
  ].join('\n');
  const out = await run(script, [
    { type: 'process' },
    FS_ROOT,
    { type: 'net', origins: [`tcp://127.0.0.1:${echo.port}`] },
  ]);

  expect(out.stdout).not.toContain('got:[hello]');
  expect(out.stdout).toMatch(/opened rc=[1-9]/);
}, 12000);

// Connection refused: allowlisted host:port but NOTHING listening → sane non-zero.
test('connection refused to a closed port → non-zero exec, no hang', async () => {
  const port = await freePort(); // nothing listens here
  const origin = `tcp://127.0.0.1:${port}`;
  const run = await bootShell([origin]); // allowlisted, so it gets PAST the gate to actually connect

  const script = [
    `exec 3<>/dev/tcp/127.0.0.1/${port}`,
    'echo "opened rc=$?"',
    'echo hello >&3',
    'read -u 3 reply',
    'echo "got:[$reply]"',
  ].join('\n');
  const out = await run(script, [
    { type: 'process' },
    FS_ROOT,
    { type: 'net', origins: [origin] },
  ]);

  // The connect failed (refused) → `exec` reports non-zero and no data round-trips.
  expect(out.stdout).not.toContain('got:[hello]');
  expect(out.stdout).toMatch(/opened rc=[1-9]/);
}, 12000);

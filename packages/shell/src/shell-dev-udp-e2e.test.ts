/**
 * DNS-over-UDP THROUGH THE SHELL via `exec N<>/dev/udp/...` + `>&N` + `read <&N`.
 *
 * The counterpart to `shell-dev-tcp-e2e.test.ts`, proving the UDP path — the exact
 * shape of a DNS-over-UDP query:
 *   exec 3<>/dev/udp/host/port    # duplex fd (fsOpenDuplex, datagram: true)
 *   echo -ne "\xNN…" >&3          # one datagram out (latin1, byte-exact write)
 *   read -t 2 -r response <&3     # ONE datagram in (input fd-dup, datagram read)
 *   exec 3>&-
 *
 * Two gaps this exercises (both fixed for UDP; TCP is untouched):
 *   A) `<&N` input-dup: `read … <&3` must SOURCE from fd 3's duplex. The redirect
 *      aliases fd 0 to fd 3's FdEntry, and plain `read` prefers an fd-0 duplex.
 *   B) datagram-aware read: a UDP datagram has no `\n` and no EOF, so a
 *      line-oriented `readLine()` would block until the `-t` timeout AND
 *      UTF-8-mangle the bytes. The duplex reads ONE datagram (latin1) so
 *      `$response` holds the raw bytes losslessly.
 *
 * BYTE MODEL NOTE: the shell's string OUTPUT sink is UTF-8 (a byte ≥ 0x80 in a
 * string, e.g. from `echo -ne "\xff"`, is emitted as its 2-byte UTF-8 form on
 * STDOUT). That is a pre-existing shell-wide constraint, orthogonal to these
 * tasks. The DATAGRAM write (`>&3`) is latin1 so the bytes on the WIRE are exact
 * regardless — proven here by capturing what the echo server RECEIVED. A DNS
 * query is all bytes < 0x80, so it also round-trips byte-exact through `od`.
 *
 * Drives the BUILT `@mithic/shell` `dist/process.js` against a loopback
 * `node:dgram` echo server. REQUIRES `npm run build` first (all dist modules —
 * the resolver imports each command's dist and spawns the shell's dist).
 */
import { expect, test, afterEach } from 'vitest';
import * as dgram from 'node:dgram';
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
import { createCoreutilsResolver } from '@mithic/coreutils';
import type { Capability } from '@mithic/protocol';

/**
 * Start a loopback UDP echo server; returns its port, the bytes of the LAST
 * datagram it received (for wire-level byte-exactness), and a stop().
 */
function startUdpEchoServer(): Promise<{
  port: number;
  lastReceived: () => number[] | undefined;
  stop: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = dgram.createSocket('udp4');
    let received: number[] | undefined;
    server.on('error', reject);
    server.on('message', (msg, rinfo) => {
      received = [...msg];
      server.send(msg, rinfo.port, rinfo.address); // echo the datagram back
    });
    server.bind(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        lastReceived: () => received,
        stop: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

/** A free 127.0.0.1 UDP port with NOTHING bound (for the no-reply timeout case). */
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = dgram.createSocket('udp4');
    probe.on('error', reject);
    probe.bind(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port)); // closed → nothing bound on `port`
    });
  });
}

const servers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });

const FS_ROOT: Capability = { type: 'fs', paths: ['/'], operations: ['read', 'write'] };

/**
 * Boot a real Kernel + WorkerRuntime + coreutils resolver (`od` for byte dumps)
 * whose VFS has `/dev/tcp` + `/dev/udp` mounted with the given net-origin
 * allowlist (Gate 2), over Node sockets. Returns a `bash -c <script>` runner.
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

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
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

// Binary round-trip, DNS-realistic (all bytes < 0x80, incl. a NUL): the datagram
// must reach the wire AND round-trip back through `read <&3` byte-exact.
test('exec 3<>/dev/udp round-trips a binary datagram byte-exact (echo -ne >&3, read <&3)', async () => {
  const echo = await startUdpEchoServer();
  servers.push(echo);
  const origin = `udp://127.0.0.1:${echo.port}`;
  const run = await bootShell([origin]);

  const script = [
    `exec 3<>/dev/udp/127.0.0.1/${echo.port}`,
    'echo -ne "\\x00\\x01\\x7f\\x41\\x42" >&3',
    'read -t 2 -r response <&3',
    // od renders $response's raw bytes — proves byte-exactness incl. the NUL.
    'printf \'%s\' "$response" | od -An -tx1',
    'exec 3>&-',
  ].join('\n');
  const out = await run(script, [
    { type: 'process' },
    FS_ROOT, // covers /dev/udp (Gate 1)
    { type: 'net', origins: [origin] }, // Gate 2 allowlist host
  ]);

  // Wire-level: the server received EXACTLY the bytes we sent.
  expect(echo.lastReceived()).toEqual([0x00, 0x01, 0x7f, 0x41, 0x42]);
  // Shell-level: `read <&3` sourced the datagram, byte-exact (od hex, incl. NUL).
  const hex = out.stdout.trim().split(/\s+/).join(' ');
  expect(hex).toBe('00 01 7f 41 42');
  expect(out.code).toBe(0);
}, 15000);

// A datagram with HIGH bytes (0xff/0xfe): the latin1 duplex write puts them on the
// WIRE byte-exact (the echo server received exactly them) — proven independent of
// the shell's UTF-8 STDOUT model, and the response length matches the datagram.
test('exec 3<>/dev/udp writes high bytes to the wire byte-exact', async () => {
  const echo = await startUdpEchoServer();
  servers.push(echo);
  const origin = `udp://127.0.0.1:${echo.port}`;
  const run = await bootShell([origin]);

  const script = [
    `exec 3<>/dev/udp/127.0.0.1/${echo.port}`,
    'echo -ne "\\x00\\xff\\xfe\\x41" >&3',
    'read -t 2 -r response <&3',
    'echo "len=${#response}"',
    // Read-back ordinal of the high byte (0xff at index 1): latin1 → 255, a UTF-8
    // decode regression → 65533 (replacement char). This gives readDatagram's
    // latin1 DECODE path real teeth (the wire assertion below only guards WRITE).
    'printf \'ord1=%d\\n\' "\'${response:1:1}"',
    'exec 3>&-',
  ].join('\n');
  const out = await run(script, [
    { type: 'process' },
    FS_ROOT,
    { type: 'net', origins: [origin] },
  ]);

  // The 4 bytes reached the wire EXACTLY (latin1 write — no UTF-8 expansion).
  expect(echo.lastReceived()).toEqual([0x00, 0xff, 0xfe, 0x41]);
  // `read <&3` read the whole 4-byte datagram back (latin1 → 4 code units)...
  expect(out.stdout).toContain('len=4');
  // ...and the high byte round-tripped byte-exact (255, NOT the UTF-8 U+FFFD=65533).
  expect(out.stdout).toContain('ord1=255');
  expect(out.code).toBe(0);
}, 15000);

// The EXACT DNS-over-UDP query from the goal (all bytes < 0x80) — the full script
// (exec <>, echo -ne >&3, read -t <&3, exec >&-) round-trips it byte-exact.
test('exec 3<>/dev/udp round-trips a realistic DNS query datagram', async () => {
  const echo = await startUdpEchoServer();
  servers.push(echo);
  const origin = `udp://127.0.0.1:${echo.port}`;
  const run = await bootShell([origin]);

  // A DNS query for one.one.one (12-byte header + QNAME + QTYPE/QCLASS), all < 0x80.
  const query = '\\x00\\x01\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x03one\\x03one\\x03one\\x00\\x00\\x01\\x00\\x01';
  const script = [
    `exec 3<>/dev/udp/127.0.0.1/${echo.port}`,
    `echo -ne "${query}" >&3`,
    'read -t 2 -r response <&3',
    'printf \'%s\' "$response" | od -An -tx1',
    'exec 3>&-',
  ].join('\n');
  const out = await run(script, [
    { type: 'process' },
    FS_ROOT,
    { type: 'net', origins: [origin] },
  ]);

  // Expected wire bytes: header 00 01 01 00 00 01 00 00 00 00 00 00, then
  // 03 'o''n''e' × 3 labels, 00 terminator, QTYPE 00 01, QCLASS 00 01.
  const label = [0x03, 0x6f, 0x6e, 0x65]; // 3 'o' 'n' 'e'
  const expected = [
    0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...label, ...label, ...label, 0x00, 0x00, 0x01, 0x00, 0x01,
  ];
  expect(echo.lastReceived()).toEqual(expected);
  const hex = out.stdout.trim().split(/\s+/).map((h) => parseInt(h, 16));
  expect(hex).toEqual(expected);
  expect(out.code).toBe(0);
}, 15000);

// Timeout: no listener on the port → no echo → `read -t 1` must race the timer
// over the UDP fd and return bash's read-timeout status (142 = 128+SIGALRM),
// NOT hang. Confirms the datagram-read path is `-t`-abortable like `read -u N`.
test('read -t over a UDP fd with no reply times out (rc=142), no hang', async () => {
  const deadPort = await freeUdpPort(); // nothing bound here → no datagram comes back
  const origin = `udp://127.0.0.1:${deadPort}`;
  const run = await bootShell([origin]); // allowlisted so the open succeeds

  const script = [
    `exec 3<>/dev/udp/127.0.0.1/${deadPort}`,
    'echo -ne "\\x00\\x01" >&3',
    'read -t 1 -r r <&3',
    'echo "rc=$?"',
    'exec 3>&-',
  ].join('\n');
  const started = Date.now();
  const out = await run(script, [
    { type: 'process' },
    FS_ROOT,
    { type: 'net', origins: [origin] },
  ]);
  const elapsed = Date.now() - started;

  expect(out.stdout).toContain('rc=142');
  expect(elapsed).toBeLessThan(10000); // timed out ~1s, did not hang to the test cap
}, 15000);

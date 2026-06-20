/**
 * Tests for {@link mountNetworkDevices} (the /dev/tcp + /dev/udp wiring helper)
 * and a real-socket loopback proof that the network-device provider performs a
 * full open → write → read → close round-trip against a live TCP server through
 * the FileSystemRouter (NOT a mock).
 *
 * These prove the io-side of the raw-socket path is functional and
 * capability-gated; the remaining shell `<>`/numbered-fd + kernel mount-hook
 * wiring is a documented cross-cluster integration point (see the header of
 * network-device.ts and the cross-cluster note in mountNetworkDevices' jsdoc).
 */
import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { FileSystemRouter } from '../router.ts';
import { FileSystemError } from '../provider.ts';
import { mountNetworkDevices, netOriginsToAllow } from './network-device.ts';
import { NodeSocketProvider } from '../../net/providers/node-socket-provider.ts';

describe('netOriginsToAllow', () => {
  it('maps http(s) origins to host + default port', () => {
    expect(netOriginsToAllow(['https://api.example.com'])).toEqual([{ host: 'api.example.com', port: 443 }]);
    expect(netOriginsToAllow(['http://api.example.com'])).toEqual([{ host: 'api.example.com', port: 80 }]);
  });

  it('honors an explicit port in an origin', () => {
    expect(netOriginsToAllow(['http://localhost:8080'])).toEqual([{ host: 'localhost', port: 8080 }]);
  });

  it('maps tcp:// and udp:// origins to host:port', () => {
    expect(netOriginsToAllow(['tcp://127.0.0.1:9000'])).toEqual([{ host: '127.0.0.1', port: 9000 }]);
    expect(netOriginsToAllow(['udp://127.0.0.1:53'])).toEqual([{ host: '127.0.0.1', port: 53 }]);
  });

  it('maps a bare host:port', () => {
    expect(netOriginsToAllow(['127.0.0.1:8080'])).toEqual([{ host: '127.0.0.1', port: 8080 }]);
  });

  it('maps a bare host (no port) to any-port', () => {
    expect(netOriginsToAllow(['example.com'])).toEqual([{ host: 'example.com' }]);
  });

  it('drops unparseable origins', () => {
    expect(netOriginsToAllow(['', '::::', 'not a url at all with spaces'])).toEqual([]);
  });
});

describe('mountNetworkDevices', () => {
  let router: FileSystemRouter;

  beforeEach(() => {
    router = new FileSystemRouter();
  });

  it('mounts /dev/tcp and /dev/udp on the router', async () => {
    await mountNetworkDevices(router, {
      sockets: new NodeSocketProvider(),
      allow: [{ host: '127.0.0.1' }],
    });
    const mounts = router.getMounts();
    expect(mounts.has('/dev/tcp')).toBe(true);
    expect(mounts.has('/dev/udp')).toBe(true);
  });

  it('gates the mounted /dev/tcp by the allowlist (denied host rejected)', async () => {
    await mountNetworkDevices(router, {
      sockets: new NodeSocketProvider(),
      allow: [{ host: '127.0.0.1', port: 8080 }],
    });
    await expect(router.open('/dev/tcp/10.0.0.1/8080', { read: true }))
      .rejects.toBeInstanceOf(FileSystemError);
  });
});

describe('network-device loopback (real TCP socket round-trip)', () => {
  let echoServer: Server;
  let port: number;
  let router: FileSystemRouter;

  beforeEach(async () => {
    echoServer = createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (chunk) => { socket.write(chunk); });
    });
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
    port = (echoServer.address() as { port: number }).port;
    router = new FileSystemRouter();
    await mountNetworkDevices(router, {
      sockets: new NodeSocketProvider(),
      allow: [{ host: '127.0.0.1' }],
    });
  });

  afterEach(() => {
    echoServer.close();
  });

  it('open → write → read → close round-trips against a live echo server', async () => {
    const handle = await router.open(`/dev/tcp/127.0.0.1/${port}`, { read: true, write: true });
    const payload = new TextEncoder().encode('hello-loopback');
    const written = await router.write(handle, payload, 0);
    expect(written).toBe(payload.byteLength);

    // The echo server bounces the bytes back; read until we have them all.
    const decoder = new TextDecoder();
    let received = '';
    for (let i = 0; i < 10 && received.length < payload.byteLength; i++) {
      const chunk = await router.read(handle, 0, 1024);
      received += decoder.decode(chunk);
    }
    expect(received).toBe('hello-loopback');
    await router.close(handle);
  }, 10000);

  it('a denied host never connects to the live server (SSRF gate holds)', async () => {
    // 127.0.0.2 is loopback but NOT on the allowlist (only 127.0.0.1 is).
    await expect(router.open(`/dev/tcp/127.0.0.2/${port}`, { read: true }))
      .rejects.toMatchObject({ code: 'access' });
  }, 10000);
});

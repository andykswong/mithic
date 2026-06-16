import { expect, test } from 'vitest';
import { SyscallDispatcher } from './syscall-dispatch.ts';
import { CapabilityManager } from './capability-manager.ts';
import { IpcBroker } from './ipc-broker.ts';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

async function makeDispatcher() {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  const caps = new CapabilityManager();
  const ipc = new IpcBroker();
  const d = new SyscallDispatcher({ vfs: router, caps, cwdOf: () => '/', ipc });
  return { d, caps, ipc };
}

// Exchange one message over the pipe protocol (PipeData/PipeCredit wire format).
// Sends `msg` from writePort to readPort and resolves with the received text.
function sendReceive(writePort: MessagePort, readPort: MessagePort, msg: string): Promise<string> {
  return new Promise((resolve) => {
    readPort.start?.();
    readPort.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; chunk?: Uint8Array };
      if (m?.type === 'data' && m.chunk) {
        resolve(new TextDecoder().decode(m.chunk));
      }
    };
    // Grant credit so writer does not stall waiting for flow-control.
    writePort.postMessage({ type: 'credit', bytes: 1 << 20 });
    readPort.postMessage({ type: 'credit', bytes: 1 << 20 });
    writePort.postMessage({ type: 'data', chunk: new TextEncoder().encode(msg) });
  });
}

test('ipc/listen binds a path, ipc/connect creates connection, ipc/accept delivers connfd — round-trip data', async () => {
  const { d, caps } = await makeDispatcher();
  const serverPid = 10;
  const clientPid = 11;
  caps.grant(serverPid, [{ type: 'ipc', channels: ['/ipc/clipboard'] }]);
  caps.grant(clientPid, [{ type: 'ipc', channels: ['/ipc/clipboard'] }]);

  // Server listens.
  const listenRes = await d.dispatch(serverPid, { id: 1, call: 'ipc/listen', args: { path: '/ipc/clipboard' } });
  expect(listenRes.response.ok).toBe(true);
  const listenfd = (listenRes.response as { ok: true; result: { fd: number } }).result.fd;

  // Client connects — gets a connection port transferred.
  const connectRes = await d.dispatch(clientPid, { id: 2, call: 'ipc/connect', args: { path: '/ipc/clipboard' } });
  expect(connectRes.response.ok).toBe(true);
  expect(connectRes.transfer).toHaveLength(1);
  const clientPort = connectRes.transfer![0] as MessagePort;
  const connfd = (connectRes.response as { ok: true; result: { connfd: number } }).result.connfd;
  expect(typeof connfd).toBe('number');

  // Server accepts — gets the other side of the channel.
  const acceptRes = await d.dispatch(serverPid, { id: 3, call: 'ipc/accept', args: { fd: listenfd } });
  expect(acceptRes.response.ok).toBe(true);
  expect(acceptRes.transfer).toHaveLength(1);
  const serverPort = acceptRes.transfer![0] as MessagePort;
  const serverConnfd = (acceptRes.response as { ok: true; result: { connfd: number } }).result.connfd;
  expect(typeof serverConnfd).toBe('number');

  // Client writes "get", server reads it.
  const serverReceived = sendReceive(clientPort, serverPort, 'get');
  // Server writes "DATA", client reads it.
  const clientReceived = sendReceive(serverPort, clientPort, 'DATA');

  expect(await serverReceived).toBe('get');
  expect(await clientReceived).toBe('DATA');

  clientPort.close();
  serverPort.close();
});

test('multiple clients each get their own connection fd', async () => {
  const { d, caps } = await makeDispatcher();
  const serverPid = 20;
  const clientA = 21;
  const clientB = 22;
  caps.grant(serverPid, [{ type: 'ipc', channels: ['/ipc/multi'] }]);
  caps.grant(clientA, [{ type: 'ipc', channels: ['/ipc/multi'] }]);
  caps.grant(clientB, [{ type: 'ipc', channels: ['/ipc/multi'] }]);

  const listenRes = await d.dispatch(serverPid, { id: 1, call: 'ipc/listen', args: { path: '/ipc/multi' } });
  const listenfd = (listenRes.response as { ok: true; result: { fd: number } }).result.fd;

  // Both clients connect before any accept.
  const connA = await d.dispatch(clientA, { id: 2, call: 'ipc/connect', args: { path: '/ipc/multi' } });
  const connB = await d.dispatch(clientB, { id: 3, call: 'ipc/connect', args: { path: '/ipc/multi' } });
  // Each client has its own fd table (separate pids), so the same fd number is valid.
  // Just confirm both connects succeeded.
  expect(connA.response.ok).toBe(true);
  expect(connB.response.ok).toBe(true);

  // Server accepts both — each accept returns a distinct connfd.
  const accA = await d.dispatch(serverPid, { id: 4, call: 'ipc/accept', args: { fd: listenfd } });
  const accB = await d.dispatch(serverPid, { id: 5, call: 'ipc/accept', args: { fd: listenfd } });
  const sConnfdA = (accA.response as { ok: true; result: { connfd: number } }).result.connfd;
  const sConnfdB = (accB.response as { ok: true; result: { connfd: number } }).result.connfd;
  expect(sConnfdA).not.toBe(sConnfdB);

  for (const r of [connA, connB, accA, accB]) {
    if (r.transfer) for (const t of r.transfer) (t as MessagePort).close();
  }
});

test('ipc/connect to unbound path returns ENOENT', async () => {
  const { d, caps } = await makeDispatcher();
  caps.grant(99, [{ type: 'ipc', channels: ['/ipc/nowhere'] }]);
  const res = await d.dispatch(99, { id: 1, call: 'ipc/connect', args: { path: '/ipc/nowhere' } });
  expect(res.response).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
});

test('ipc/listen without ipc capability returns EACCES', async () => {
  const { d } = await makeDispatcher();
  // pid 30 has no capabilities granted.
  const res = await d.dispatch(30, { id: 1, call: 'ipc/listen', args: { path: '/ipc/clipboard' } });
  expect(res.response).toMatchObject({ ok: false, error: { code: 'EACCES' } });
});

test('ipc/connect without ipc capability returns EACCES', async () => {
  const { d, caps } = await makeDispatcher();
  const serverPid = 40;
  caps.grant(serverPid, [{ type: 'ipc', channels: ['/ipc/secret'] }]);
  await d.dispatch(serverPid, { id: 1, call: 'ipc/listen', args: { path: '/ipc/secret' } });
  // client pid 41 has no ipc cap.
  const res = await d.dispatch(41, { id: 2, call: 'ipc/connect', args: { path: '/ipc/secret' } });
  expect(res.response).toMatchObject({ ok: false, error: { code: 'EACCES' } });
});

test('fs/close on a listener fd unbinds the path so subsequent connects return ENOENT', async () => {
  const { d, caps, ipc } = await makeDispatcher();
  const serverPid = 50;
  const clientPid = 51;
  caps.grant(serverPid, [{ type: 'ipc', channels: ['/ipc/tmp'] }]);
  caps.grant(clientPid, [{ type: 'ipc', channels: ['/ipc/tmp'] }]);

  const listenRes = await d.dispatch(serverPid, { id: 1, call: 'ipc/listen', args: { path: '/ipc/tmp' } });
  const listenfd = (listenRes.response as { ok: true; result: { fd: number } }).result.fd;
  expect(ipc.resolveListener('/ipc/tmp')).toBe(serverPid);

  // Close the listener fd — should unbind the path.
  const closeRes = await d.dispatch(serverPid, { id: 2, call: 'fs/close', args: { fd: listenfd } });
  expect(closeRes.response.ok).toBe(true);
  expect(ipc.resolveListener('/ipc/tmp')).toBeUndefined();

  // A subsequent connect must now fail with ENOENT.
  const connectRes = await d.dispatch(clientPid, { id: 3, call: 'ipc/connect', args: { path: '/ipc/tmp' } });
  expect(connectRes.response).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
});

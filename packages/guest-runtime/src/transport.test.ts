import { expect, test } from 'vitest';
import { MessagePortTransport } from './transport.ts';

test('MessagePortTransport sends and receives over a MessageChannel', async () => {
  const { port1, port2 } = new MessageChannel();
  const a = new MessagePortTransport(port1);
  const got: unknown[] = [];
  const b = new MessagePortTransport(port2);
  b.onMessage(m => got.push(m));
  a.send({ id: 1, call: 'process/getpid', args: {} });
  await new Promise(r => setTimeout(r, 20));
  expect(got).toContainEqual({ id: 1, call: 'process/getpid', args: {} });
  a.close(); b.close();
});

// B5: the transport must surface transferred MessagePorts to its consumer.
test('B5: MessagePortTransport delivers transferred ports to onMessage', async () => {
  const { port1, port2 } = new MessageChannel();
  const a = new MessagePortTransport(port1);
  const b = new MessagePortTransport(port2);

  const received: Array<{ msg: unknown; ports: readonly MessagePort[] }> = [];
  b.onMessage((msg, ports) => received.push({ msg, ports: ports ?? [] }));

  // Send a payload that carries a transferred port (a fresh channel's port).
  const carried = new MessageChannel();
  a.send({ id: 9, ok: true, result: { readfd: 3 } }, [carried.port1]);

  await new Promise(r => setTimeout(r, 20));
  expect(received).toHaveLength(1);
  expect(received[0].msg).toEqual({ id: 9, ok: true, result: { readfd: 3 } });
  expect(received[0].ports).toHaveLength(1);
  // The delivered port is usable: round-trip a message through it.
  const delivered = received[0].ports[0];
  delivered.start?.();
  const echoed = new Promise<unknown>((resolve) => { delivered.onmessage = (e) => resolve(e.data); });
  carried.port2.postMessage('ping');
  expect(await echoed).toBe('ping');

  a.close(); b.close();
});

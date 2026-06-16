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

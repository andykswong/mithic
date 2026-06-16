import { expect, test } from 'vitest';
import { MessagePortTransport } from './transport.ts';
import { SyscallClient } from './syscall-client.ts';

test('SyscallClient resolves on ok response', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));

  // Simulate kernel side: echo back a response
  port2.onmessage = (e) => {
    const req = e.data as { id: number; call: string };
    port2.postMessage({ id: req.id, ok: true, result: { pid: 42 } });
  };

  const result = await client.syscall('process/getpid', {});
  expect(result).toEqual({ pid: 42 });
  port1.close(); port2.close();
});

test('SyscallClient rejects on error response', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));

  port2.onmessage = (e) => {
    const req = e.data as { id: number };
    port2.postMessage({ id: req.id, ok: false, error: { code: 'EBADF', message: 'bad file descriptor' } });
  };

  await expect(client.syscall('fd/read', { fd: 99 })).rejects.toThrow('bad file descriptor');
  port1.close(); port2.close();
});

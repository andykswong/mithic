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

test('SyscallClient correlates concurrent out-of-order responses correctly', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));

  // Collect requests in order, then reply out-of-order: respond to id 2 before id 1.
  const requests: Array<{ id: number; call: string }> = [];
  port2.onmessage = async (e) => {
    requests.push(e.data as { id: number; call: string });
    if (requests.length === 2) {
      // Reply to the second request first.
      port2.postMessage({ id: requests[1].id, ok: true, result: { value: 'second' } });
      // Small delay, then reply to the first.
      await new Promise(r => setTimeout(r, 5));
      port2.postMessage({ id: requests[0].id, ok: true, result: { value: 'first' } });
    }
  };

  // Fire both concurrently without awaiting the first.
  const p1 = client.syscall('op/one', {});
  const p2 = client.syscall('op/two', {});

  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toEqual({ value: 'first' });
  expect(r2).toEqual({ value: 'second' });

  port1.close(); port2.close();
});

test('SyscallClient.close() rejects all pending syscalls with EPIPE', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));

  // Start a syscall but do NOT respond — it stays pending.
  const pending = client.syscall('op/hang', {});

  // Close the client; pending call must reject.
  client.close();

  await expect(pending).rejects.toMatchObject({ message: 'transport closed', code: 'EPIPE' });
  port2.close();
});

// Fix 2 regression: opt-in per-call timeout rejects with ETIMEDOUT
test('Fix 2: syscall rejects with ETIMEDOUT when timeoutMs set and kernel never responds', async () => {
  const { port1, port2 } = new MessageChannel();
  // Kernel side: never responds.
  port2.start?.();

  const client = new SyscallClient(new MessagePortTransport(port1), { timeoutMs: 50 });

  const start = Date.now();
  await expect(client.syscall('op/hang', {})).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  // Should have rejected within ~200 ms (well above 50 ms but not a hang).
  expect(Date.now() - start).toBeLessThan(1000);

  port1.close();
  port2.close();
});

// Fix 2 regression: without timeoutMs, behaviour is unchanged (resolves normally)
test('Fix 2: without timeoutMs option, syscall resolves normally when kernel responds', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));

  port2.onmessage = (e) => {
    const req = e.data as { id: number };
    port2.postMessage({ id: req.id, ok: true, result: { answer: 42 } });
  };

  const result = await client.syscall('op/echo', {});
  expect(result).toEqual({ answer: 42 });

  port1.close();
  port2.close();
});

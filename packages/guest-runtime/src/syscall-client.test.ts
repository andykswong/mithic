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

// --- B1: per-call signal / timeoutMs threading ---

test('B1: a per-call AbortSignal cancels an in-flight syscall with ECANCELED', async () => {
  const { port1, port2 } = new MessageChannel();
  port2.start?.(); // kernel side never responds
  const client = new SyscallClient(new MessagePortTransport(port1));

  const controller = new AbortController();
  const pending = client.syscall('op/hang', {}, { signal: controller.signal });
  controller.abort();

  await expect(pending).rejects.toMatchObject({ code: 'ECANCELED' });
  port1.close(); port2.close();
});

test('B1: an already-aborted signal rejects synchronously without sending', async () => {
  const { port1, port2 } = new MessageChannel();
  let sent = false;
  port2.onmessage = () => { sent = true; };
  port2.start?.();
  const client = new SyscallClient(new MessagePortTransport(port1));

  const controller = new AbortController();
  controller.abort();
  await expect(client.syscall('op/x', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'ECANCELED' });
  // Give any stray message a tick; nothing should have been sent.
  await new Promise((r) => setTimeout(r, 10));
  expect(sent).toBe(false);
  port1.close(); port2.close();
});

test('B1: a per-call timeoutMs overrides the client default and rejects with ETIMEDOUT', async () => {
  const { port1, port2 } = new MessageChannel();
  port2.start?.(); // never responds
  const client = new SyscallClient(new MessagePortTransport(port1), { timeoutMs: 10_000 });

  const start = Date.now();
  await expect(client.syscall('op/hang', {}, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(Date.now() - start).toBeLessThan(1000); // honored the SHORT per-call timeout
  port1.close(); port2.close();
});

// --- B5: transferred ports surfaced alongside the syscall result ---

test('B5: syscallPorts returns transferred ports alongside the result', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));

  // Kernel side: respond to fs/pipe with two transferred ports (read + write).
  port2.onmessage = (e) => {
    const req = e.data as { id: number; call: string };
    const pipe = new MessageChannel();
    port2.postMessage(
      { id: req.id, ok: true, result: { readfd: 3, writefd: 4 } },
      [pipe.port1, pipe.port2],
    );
  };

  const { result, ports } = await client.syscallPorts('fs/pipe', {});
  expect(result).toEqual({ readfd: 3, writefd: 4 });
  expect(ports).toHaveLength(2);
  // The ports are entangled with each other — write to one, read on the other.
  ports[0].start?.();
  ports[1].start?.();
  const got = new Promise<unknown>((resolve) => { ports[1].onmessage = (e) => resolve(e.data); });
  ports[0].postMessage('hi');
  expect(await got).toBe('hi');

  port1.close(); port2.close();
});

test('B5: syscallPorts yields an empty port list for a plain result', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));
  port2.onmessage = (e) => {
    const req = e.data as { id: number };
    port2.postMessage({ id: req.id, ok: true, result: { pid: 7 } });
  };
  const { result, ports } = await client.syscallPorts('process/getpid', {});
  expect(result).toEqual({ pid: 7 });
  expect(ports).toEqual([]);
  port1.close(); port2.close();
});

test('B5: syscall() (no ports) still works when a response carries ports', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));
  port2.onmessage = (e) => {
    const req = e.data as { id: number };
    const pipe = new MessageChannel();
    port2.postMessage({ id: req.id, ok: true, result: { readfd: 3 } }, [pipe.port1]);
  };
  // Legacy callers that ignore ports still get the result.
  const result = await client.syscall('fs/pipe', {});
  expect(result).toEqual({ readfd: 3 });
  port1.close(); port2.close();
});

test('B1: a normal response settles cleanly even with a signal supplied (no leak)', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = new SyscallClient(new MessagePortTransport(port1));
  port2.onmessage = (e) => {
    const req = e.data as { id: number };
    port2.postMessage({ id: req.id, ok: true, result: { ok: 1 } });
  };
  const controller = new AbortController();
  const result = await client.syscall('op/echo', {}, { signal: controller.signal });
  expect(result).toEqual({ ok: 1 });
  // Aborting AFTER the call settled must not throw / double-settle.
  controller.abort();
  port1.close(); port2.close();
});

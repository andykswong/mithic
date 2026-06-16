import { expect, test } from 'vitest';
import { INITIAL_CREDIT_BYTES } from '@mithic/protocol';
import { createGuest } from './isola.ts';

function makeGuest(preopenPorts?: Record<number, MessagePort>) {
  const ctrl = new MessageChannel();
  const guest = createGuest({
    control: ctrl.port2,
    init: {
      type: 'init', entry: 'inline', args: ['prog', 'a'], env: { FOO: 'bar' },
      cwd: '/', pid: 9, ppid: 0, capabilities: [],
    },
    preopenPorts,
  });
  return { guest, kernelPort: ctrl.port1 };
}

test('createGuest exposes env/args/pid and stdio from init', async () => {
  const stdoutCh = new MessageChannel();
  const { guest } = makeGuest({ 1: stdoutCh.port1 });

  expect(guest.pid).toBe(9);
  expect(guest.args).toEqual(['prog', 'a']);
  expect(guest.env.FOO).toBe('bar');

  // Grant credit to the writable (port1) from the peer (port2) so write unblocks.
  stdoutCh.port2.start?.();
  stdoutCh.port2.postMessage({ type: 'credit', bytes: INITIAL_CREDIT_BYTES });

  const got: unknown[] = [];
  stdoutCh.port2.onmessage = (e) => got.push(e.data);

  const w = guest.stdout.getWriter();
  await w.write(new TextEncoder().encode('hi'));

  await new Promise(r => setTimeout(r, 20));
  expect(got.some(m => (m as { type?: string }).type === 'data')).toBe(true);

  stdoutCh.port1.close();
  stdoutCh.port2.close();
});

test('onSignal fires for kernel signal event and is not mis-delivered to syscall', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  // Register the signal listener.
  const signals: string[] = [];
  guest.onSignal((sig) => signals.push(sig));

  // Kernel posts a signal event.
  kernelPort.postMessage({ event: 'signal', payload: { signal: 'SIGTERM' } });

  await new Promise(r => setTimeout(r, 20));
  expect(signals).toEqual(['SIGTERM']);

  // Also verify a pending syscall is NOT mis-delivered as a signal.
  // Start a syscall, reply with a valid syscall response — the signal listener must not fire.
  const syscallPromise = guest.syscall('process/getpid', {});
  kernelPort.onmessage = (e) => {
    const req = e.data as { id: number };
    if (req.id != null) {
      kernelPort.postMessage({ id: req.id, ok: true, result: { pid: 9 } });
    }
  };
  await syscallPromise;
  // Signal listeners should still only contain the original SIGTERM.
  expect(signals).toEqual(['SIGTERM']);

  kernelPort.close();
});

test('exit posts {type:"exit",code} and rejects in-flight syscalls', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  // Collect messages sent to the kernel port.
  const kernelMessages: unknown[] = [];
  kernelPort.onmessage = (e) => kernelMessages.push(e.data);

  // Start a syscall that will never get a response.
  const hangingCall = guest.syscall('op/hang', {});

  // Call exit — should post {type:'exit',code} and close the transport.
  guest.exit(42);

  // Hanging syscall must reject with EPIPE.
  await expect(hangingCall).rejects.toMatchObject({ code: 'EPIPE' });

  await new Promise(r => setTimeout(r, 10));
  const exitMsg = kernelMessages.find(m => (m as { type?: string }).type === 'exit');
  expect(exitMsg).toMatchObject({ type: 'exit', code: 42 });

  kernelPort.close();
});

test('syscall response is NOT delivered to the signal handler', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const signals: string[] = [];
  guest.onSignal((sig) => signals.push(sig));

  // Reply immediately to the syscall.
  kernelPort.onmessage = (e) => {
    const req = e.data as { id: number };
    if (req.id != null) {
      kernelPort.postMessage({ id: req.id, ok: true, result: {} });
    }
  };

  await guest.syscall('op/noop', {});

  await new Promise(r => setTimeout(r, 10));
  expect(signals).toEqual([]);

  kernelPort.close();
});

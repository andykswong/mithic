import { expect, test } from 'vitest';
import { createGuest } from './guest.ts';
import { MutationSerializer, VNode } from './remote-dom.ts';

function makeGuest(preopenPorts?: Record<number, MessagePort>) {
  const ctrl = new MessageChannel();
  const guest = createGuest({
    control: ctrl.port2,
    init: {
      type: 'init', entry: 'inline', args: ['prog'], env: {},
      cwd: '/', pid: 7, ppid: 0, capabilities: [],
    },
    preopenPorts,
  });
  return { guest, kernelPort: ctrl.port1 };
}

// ── B4: VNode IS a real EventTarget ────────────────────────────────────────

test('B4: VNode extends EventTarget — addEventListener fires on a synthesized dom/event', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const serializer = new MutationSerializer(guest);
  const button = serializer.createElement('button');
  expect(button).toBeInstanceOf(EventTarget);

  const events: Event[] = [];
  button.addEventListener('click', (e) => { events.push(e); });

  kernelPort.postMessage({
    event: 'dom/event',
    payload: { nodeId: button.id, eventType: 'click', payload: { x: 10 } },
  });

  await new Promise((r) => setTimeout(r, 20));
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('click');
  // The forwarded payload rides in CustomEvent.detail.
  expect((events[0] as CustomEvent).detail).toMatchObject({ x: 10 });

  kernelPort.close();
});

test('B4: removeEventListener stops a VNode listener from firing', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const serializer = new MutationSerializer(guest);
  const el = serializer.createElement('div');
  let count = 0;
  const cb = (): void => { count++; };
  el.addEventListener('input', cb);

  const fire = (): void => {
    kernelPort.postMessage({ event: 'dom/event', payload: { nodeId: el.id, eventType: 'input', payload: {} } });
  };

  fire();
  await new Promise((r) => setTimeout(r, 20));
  expect(count).toBe(1);

  el.removeEventListener('input', cb);
  fire();
  await new Promise((r) => setTimeout(r, 20));
  expect(count).toBe(1); // unchanged — listener removed

  kernelPort.close();
});

test('B4: a dom/event for a different node id does not reach the listener', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const serializer = new MutationSerializer(guest);
  const a = serializer.createElement('div');
  let hits = 0;
  a.addEventListener('click', () => { hits++; });

  kernelPort.postMessage({ event: 'dom/event', payload: { nodeId: a.id + 1000, eventType: 'click', payload: {} } });
  await new Promise((r) => setTimeout(r, 20));
  expect(hits).toBe(0);

  kernelPort.close();
});

test('B4: addEventListener with an AbortSignal removes the listener on abort (standard EventTarget)', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const serializer = new MutationSerializer(guest);
  const el = serializer.createElement('div');
  let count = 0;
  const ac = new AbortController();
  el.addEventListener('click', () => { count++; }, { signal: ac.signal });

  const fire = (): void => {
    kernelPort.postMessage({ event: 'dom/event', payload: { nodeId: el.id, eventType: 'click', payload: {} } });
  };
  fire();
  await new Promise((r) => setTimeout(r, 20));
  expect(count).toBe(1);

  ac.abort();
  fire();
  await new Promise((r) => setTimeout(r, 20));
  expect(count).toBe(1); // the standard EventTarget honoured signal removal

  kernelPort.close();
});

// ── B4: guest.signal — derived AbortSignal over the TERMINAL signal subset ──

test('B4: guest.signal aborts on SIGTERM', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  expect(guest.signal).toBeInstanceOf(AbortSignal);
  expect(guest.signal.aborted).toBe(false);

  let abortedReason: unknown;
  guest.signal.addEventListener('abort', () => { abortedReason = guest.signal.reason; });

  kernelPort.postMessage({ event: 'signal', payload: { signal: 'SIGTERM' } });
  await new Promise((r) => setTimeout(r, 20));

  expect(guest.signal.aborted).toBe(true);
  expect(abortedReason).toBeDefined();

  kernelPort.close();
});

test('B4: guest.signal aborts on SIGINT', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  kernelPort.postMessage({ event: 'signal', payload: { signal: 'SIGINT' } });
  await new Promise((r) => setTimeout(r, 20));
  expect(guest.signal.aborted).toBe(true);

  kernelPort.close();
});

test('B4: onSignal stays MULTI-SHOT — SIGUSR1 fires repeatably while guest.signal is NOT aborted', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const received: string[] = [];
  guest.onSignal((sig) => received.push(sig));

  kernelPort.postMessage({ event: 'signal', payload: { signal: 'SIGUSR1' } });
  kernelPort.postMessage({ event: 'signal', payload: { signal: 'SIGUSR1' } });
  kernelPort.postMessage({ event: 'signal', payload: { signal: 'SIGUSR2' } });
  await new Promise((r) => setTimeout(r, 20));

  // Multi-shot: every signal delivered, including repeats.
  expect(received).toEqual(['SIGUSR1', 'SIGUSR1', 'SIGUSR2']);
  // Non-terminal signals must NOT abort the derived terminal-only signal.
  expect(guest.signal.aborted).toBe(false);

  kernelPort.close();
});

test('B4: a terminal signal reaches BOTH onSignal (multi-shot) and guest.signal (derived abort)', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const received: string[] = [];
  guest.onSignal((sig) => received.push(sig));

  kernelPort.postMessage({ event: 'signal', payload: { signal: 'SIGTERM' } });
  await new Promise((r) => setTimeout(r, 20));

  expect(received).toEqual(['SIGTERM']);   // onSignal still gets it
  expect(guest.signal.aborted).toBe(true); // and the derived view aborts

  kernelPort.close();
});

// Keep VNode importable as a value (it is a class now).
test('B4: VNode is constructible without a serializer and is an EventTarget', () => {
  const node = new VNode('element', 'span', null);
  expect(node).toBeInstanceOf(EventTarget);
  expect(node.tagName).toBe('span');
});

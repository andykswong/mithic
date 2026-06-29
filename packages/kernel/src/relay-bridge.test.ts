import { expect, test } from 'vitest';
import { RelayBridge } from './relay-bridge.ts';

function makeDispatch() {
  return async () => ({ response: { id: 0, ok: true, result: {} } as const });
}

test('registerStdin: a registered fd-0 end yields bytes via pipeRead then EOF', async () => {
  const bridge = new RelayBridge(makeDispatch());
  const pid = 7;
  // Kernel side: a MessageChannel whose read end the bridge holds at fd 0,
  // whose write end the kernel feeds.
  const ch = new MessageChannel();
  bridge.registerStdin(pid, ch.port1);

  // Feed bytes from the kernel-held write peer, then EOF.
  // The RelayEnd grants an initial credit window on construction, so a direct
  // post is accepted.
  ch.port2.postMessage({ type: 'data', chunk: new TextEncoder().encode('hi') });
  ch.port2.postMessage({ type: 'end' });

  const first = await bridge.pipeRead(pid, 0);
  expect(first.ok).toBe(true);
  expect(new Uint8Array((first as { result: { data: number[] } }).result.data)).toEqual(
    new TextEncoder().encode('hi'),
  );

  const eof = await bridge.pipeRead(pid, 0);
  expect(eof.ok).toBe(true);
  expect((eof as { result: { data: number[] } }).result.data).toEqual([]);
});

test('registerStdin: closeFds tears down the stdin end', async () => {
  const bridge = new RelayBridge(makeDispatch());
  const ch = new MessageChannel();
  bridge.registerStdin(3, ch.port1);
  bridge.closeFds(3);
  const r = await bridge.pipeRead(3, 0);
  expect(r.ok).toBe(false);
  expect((r as { error: { code: string } }).error.code).toBe('EBADF');
});

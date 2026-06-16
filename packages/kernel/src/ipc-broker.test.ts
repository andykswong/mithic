import { expect, test } from 'vitest';
import { IpcBroker } from './ipc-broker.ts';

test('createPipe returns two ends backed by one MessageChannel', () => {
  const broker = new IpcBroker();
  const { readPort, writePort } = broker.createPipe();
  const got: unknown[] = [];
  readPort.onmessage = (e) => got.push(e.data);
  readPort.start?.();
  writePort.postMessage({ type: 'data', chunk: new Uint8Array([1]) });
  return new Promise<void>(r => setTimeout(() => { expect(got.length).toBe(1); r(); }, 20));
});

test('named channel registry binds and resolves a listener', () => {
  const broker = new IpcBroker();
  broker.bind('/ipc/clipboard', 7);
  expect(broker.resolveListener('/ipc/clipboard')).toBe(7);
  broker.unbind('/ipc/clipboard');
  expect(broker.resolveListener('/ipc/clipboard')).toBeUndefined();
});

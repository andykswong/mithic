import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IoLoop } from './io-loop.ts';

describe('IoLoop', () => {
  it('addWorker() returns a MessagePort', () => {
    const loop = new IoLoop({ onCall: async () => null });
    const port = loop.addWorker();
    assert.ok(port);
    assert.strictEqual(typeof port.postMessage, 'function');
    assert.strictEqual(typeof port.on, 'function');
    loop.dispose();
  });

  it('addWorker() can be called multiple times (multiple workers)', () => {
    const loop = new IoLoop({ onCall: async () => null });
    const port1 = loop.addWorker();
    const port2 = loop.addWorker();
    const port3 = loop.addWorker();
    assert.notStrictEqual(port1, port2);
    assert.notStrictEqual(port2, port3);
    assert.notStrictEqual(port1, port3);
    loop.dispose();
  });

  it('removeWorker(port) removes from worker set', () => {
    const loop = new IoLoop({ onCall: async () => null });
    const port = loop.addWorker();
    loop.removeWorker(port);
    // Removing again is a no-op (doesn't throw)
    loop.removeWorker(port);
    loop.dispose();
  });

  it('dispose() clears all workers', () => {
    const loop = new IoLoop({ onCall: async () => null });
    loop.addWorker();
    loop.addWorker();
    loop.dispose();
    // No lingering handles after dispose
  });
});

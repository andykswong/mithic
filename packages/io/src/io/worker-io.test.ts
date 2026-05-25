import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { WorkerIo } from './worker-io.ts';

describe('WorkerIo', () => {
  it('constructor accepts a MessagePort', () => {
    const { port1, port2 } = new MessageChannel();
    const workerIo = new WorkerIo(port1);
    assert.ok(workerIo);
    port1.close();
    port2.close();
  });

  it('ioCall method exists and has correct signature', () => {
    const { port1, port2 } = new MessageChannel();
    const workerIo = new WorkerIo(port1);
    assert.strictEqual(typeof workerIo.ioCall, 'function');
    // ioCall accepts (call: number, id: number | null, payload?: unknown)
    assert.strictEqual(workerIo.ioCall.length, 3);
    port1.close();
    port2.close();
  });
});

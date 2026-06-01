import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExitSlot, createSignalSlot, exitSlotFromBuffer, signalSlotFromBuffer } from './slots.ts';

describe('ExitSlot', () => {
  it('initial tryWait returns undefined (not exited)', () => {
    const slot = createExitSlot();
    assert.equal(slot.tryWait(), undefined);
  });

  it('setExitCode makes tryWait return the code', () => {
    const slot = createExitSlot();
    slot.setExitCode(42);
    assert.equal(slot.tryWait(), 42);
  });

  it('setExitCode(0) is distinguishable from not-exited', () => {
    const slot = createExitSlot();
    slot.setExitCode(0);
    assert.equal(slot.tryWait(), 0);
  });

  it('wait returns immediately when exit code already set', () => {
    const slot = createExitSlot();
    slot.setExitCode(7);
    assert.equal(slot.wait(), 7);
  });

  it('exposes buffer as SharedArrayBuffer', () => {
    const slot = createExitSlot();
    assert.ok(slot.buffer instanceof SharedArrayBuffer);
  });

  it('exitSlotFromBuffer reconstitutes a working slot', () => {
    const original = createExitSlot();
    const reconstituted = exitSlotFromBuffer(original.buffer);
    original.setExitCode(99);
    assert.equal(reconstituted.tryWait(), 99);
  });

  it('exitSlotFromBuffer wait works when code set after creation', () => {
    const original = createExitSlot();
    original.setExitCode(5);
    const reconstituted = exitSlotFromBuffer(original.buffer);
    assert.equal(reconstituted.wait(), 5);
  });
});

describe('SignalSlot', () => {
  it('initial pending returns 0 (no signal)', () => {
    const slot = createSignalSlot();
    assert.equal(slot.pending(), 0);
  });

  it('send makes pending return the signal number', () => {
    const slot = createSignalSlot();
    slot.send(15); // SIGTERM
    assert.equal(slot.pending(), 15);
  });

  it('consume returns and clears the pending signal', () => {
    const slot = createSignalSlot();
    slot.send(9); // SIGKILL
    assert.equal(slot.consume(), 9);
    assert.equal(slot.pending(), 0);
  });

  it('consume returns 0 when no signal pending', () => {
    const slot = createSignalSlot();
    assert.equal(slot.consume(), 0);
  });

  it('send overwrites previous signal (last-writer-wins)', () => {
    const slot = createSignalSlot();
    slot.send(2);  // SIGINT
    slot.send(15); // SIGTERM
    assert.equal(slot.pending(), 15);
  });

  it('exposes buffer as SharedArrayBuffer', () => {
    const slot = createSignalSlot();
    assert.ok(slot.buffer instanceof SharedArrayBuffer);
  });

  it('signalSlotFromBuffer reconstitutes a working slot', () => {
    const original = createSignalSlot();
    const reconstituted = signalSlotFromBuffer(original.buffer);
    original.send(2);
    assert.equal(reconstituted.pending(), 2);
  });

  it('signalSlotFromBuffer consume works cross-reference', () => {
    const original = createSignalSlot();
    const reconstituted = signalSlotFromBuffer(original.buffer);
    original.send(15);
    assert.equal(reconstituted.consume(), 15);
    assert.equal(original.pending(), 0);
  });
});

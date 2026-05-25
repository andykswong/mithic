import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pollable, poll } from './poll.ts';

describe('Pollable', () => {
  it('ready() returns true when handler returns true', () => {
    const p = new Pollable(() => true);
    assert.equal(p.ready(), true);
  });

  it('ready() returns false when handler returns false', () => {
    const p = new Pollable(() => false);
    assert.equal(p.ready(), false);
  });

  it('block() returns immediately if ready', () => {
    const p = new Pollable(() => true);
    // Should not throw or hang
    p.block();
  });

  it('block() spins until ready (counter-based handler)', () => {
    let counter = 0;
    const p = new Pollable(() => {
      counter++;
      return counter >= 5;
    });
    p.block();
    assert.equal(counter, 5);
  });

  it('block() throws if pollable never becomes ready (timeout)', () => {
    const p = new Pollable(() => false);
    assert.throws(
      () => p.block(),
      /timed out/
    );
  });

  it('default pollable (no handler) is always ready', () => {
    const p = new Pollable();
    assert.equal(p.ready(), true);
  });
});

describe('poll', () => {
  it('throws on empty list', () => {
    assert.throws(() => poll([]), /poll list must not be empty/);
  });

  it('poll([readyPollable]) returns [0]', () => {
    const p = new Pollable(() => true);
    const result = poll([p]);
    assert.deepEqual(Array.from(result), [0]);
  });

  it('poll([notReady, ready]) returns [1]', () => {
    const p1 = new Pollable(() => false);
    const p2 = new Pollable(() => true);
    const result = poll([p1, p2]);
    assert.deepEqual(Array.from(result), [1]);
  });

  it('poll([ready1, notReady, ready2]) returns [0, 2]', () => {
    const p1 = new Pollable(() => true);
    const p2 = new Pollable(() => false);
    const p3 = new Pollable(() => true);
    const result = poll([p1, p2, p3]);
    assert.deepEqual(Array.from(result), [0, 2]);
  });

  it('poll with all not-ready eventually returns when one becomes ready', () => {
    let callCount = 0;
    const p1 = new Pollable(() => {
      callCount++;
      return callCount >= 3;
    });
    const p2 = new Pollable(() => false);
    const result = poll([p1, p2]);
    // p1 should become ready after block() calls it
    assert.ok(Array.from(result).includes(0));
  });

  it('poll with single always-ready pollable returns [0]', () => {
    const p = new Pollable();
    const result = poll([p]);
    assert.deepEqual(Array.from(result), [0]);
  });

  it('poll returns Uint32Array', () => {
    const p = new Pollable(() => true);
    const result = poll([p]);
    assert.ok(result instanceof Uint32Array);
  });
});

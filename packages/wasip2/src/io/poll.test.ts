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
    const result = poll([p]) as Uint32Array;
    assert.deepEqual(Array.from(result), [0]);
  });

  it('poll([notReady, ready]) returns [1]', () => {
    const p1 = new Pollable(() => false);
    const p2 = new Pollable(() => true);
    const result = poll([p1, p2]) as Uint32Array;
    assert.deepEqual(Array.from(result), [1]);
  });

  it('poll([ready1, notReady, ready2]) returns [0, 2]', () => {
    const p1 = new Pollable(() => true);
    const p2 = new Pollable(() => false);
    const p3 = new Pollable(() => true);
    const result = poll([p1, p2, p3]) as Uint32Array;
    assert.deepEqual(Array.from(result), [0, 2]);
  });

  it('poll with all not-ready eventually returns when one becomes ready', () => {
    let callCount = 0;
    const p1 = new Pollable(() => {
      callCount++;
      return callCount >= 3;
    });
    const p2 = new Pollable(() => false);
    const result = poll([p1, p2]) as Uint32Array;
    // p1 should become ready after block() calls it
    assert.ok(Array.from(result).includes(0));
  });

  it('poll with single always-ready pollable returns [0]', () => {
    const p = new Pollable();
    const result = poll([p]) as Uint32Array;
    assert.deepEqual(Array.from(result), [0]);
  });

  it('poll returns Uint32Array', () => {
    const p = new Pollable(() => true);
    const result = poll([p]);
    assert.ok(result instanceof Uint32Array);
  });
});

describe('Pollable (async blockReady)', () => {
  it('block() returns a Promise when blockReady returns a Promise', () => {
    const p = new Pollable(
      () => false,
      () => new Promise<void>(resolve => setTimeout(resolve, 1)),
    );
    const result = p.block();
    assert.ok(result instanceof Promise);
  });

  it('block() returns void when blockReady returns void', () => {
    let ready = false;
    const p = new Pollable(
      () => ready,
      () => { ready = true; },
    );
    const result = p.block();
    assert.equal(result, undefined);
  });

  it('block() returns void immediately when already ready (even with async blockReady)', () => {
    const p = new Pollable(
      () => true,
      () => new Promise<void>(resolve => setTimeout(resolve, 100)),
    );
    const result = p.block();
    assert.equal(result, undefined);
  });

  it('async blockReady resolves correctly', async () => {
    let ready = false;
    const p = new Pollable(
      () => ready,
      () => new Promise<void>(resolve => {
        setTimeout(() => { ready = true; resolve(); }, 5);
      }),
    );
    const result = p.block();
    assert.ok(result instanceof Promise);
    await result;
    assert.equal(p.ready(), true);
  });
});

describe('poll (async pollables)', () => {
  it('poll returns a Promise when all pollables are async', async () => {
    let ready = false;
    const p = new Pollable(
      () => ready,
      () => new Promise<void>(resolve => {
        setTimeout(() => { ready = true; resolve(); }, 5);
      }),
    );
    const result = poll([p]);
    assert.ok(result instanceof Promise);
    const indices = await result;
    assert.deepEqual(Array.from(indices), [0]);
  });

  it('poll returns Uint32Array synchronously when fast-path hits (some ready)', () => {
    const p1 = new Pollable(() => true);
    const p2 = new Pollable(
      () => false,
      () => new Promise<void>(resolve => setTimeout(resolve, 100)),
    );
    const result = poll([p1, p2]);
    assert.ok(result instanceof Uint32Array);
    assert.deepEqual(Array.from(result), [0]);
  });

  it('poll races multiple async pollables and returns all ready indices', async () => {
    let ready1 = false;
    let ready2 = false;
    const p1 = new Pollable(
      () => ready1,
      () => new Promise<void>(resolve => {
        setTimeout(() => { ready1 = true; ready2 = true; resolve(); }, 5);
      }),
    );
    const p2 = new Pollable(
      () => ready2,
      () => new Promise<void>(resolve => {
        setTimeout(() => { ready2 = true; resolve(); }, 5);
      }),
    );
    const result = poll([p1, p2]);
    assert.ok(result instanceof Promise);
    const indices = await result;
    assert.ok(Array.from(indices).includes(0));
    assert.ok(Array.from(indices).includes(1));
  });

  it('poll with mix of sync-block and async: sync becomes ready first', () => {
    let syncReady = false;
    const p1 = new Pollable(
      () => syncReady,
      () => { syncReady = true; },
    );
    const p2 = new Pollable(
      () => false,
      () => new Promise<void>(resolve => setTimeout(resolve, 100)),
    );
    const result = poll([p1, p2]);
    // p1 should become ready from sync block, so result should be sync
    assert.ok(result instanceof Uint32Array);
    assert.ok(Array.from(result).includes(0));
  });
});

describe('poll async racing', () => {
  it('poll races multiple async pollables and returns fastest', async () => {
    let ready1 = false;
    let ready2 = false;
    const p1 = new Pollable(
      () => ready1,
      () => new Promise<void>(resolve => setTimeout(() => { ready1 = true; resolve(); }, 50)),
    );
    const p2 = new Pollable(
      () => ready2,
      () => new Promise<void>(resolve => setTimeout(() => { ready2 = true; resolve(); }, 10)),
    );
    const result = poll([p1, p2]);
    assert.ok(result instanceof Promise);
    const indices = await result;
    // p2 resolves first (10ms < 50ms)
    assert.ok(Array.from(indices).includes(1));
  });

  it('poll with async pollable that rejects propagates error', async () => {
    const p = new Pollable(
      () => false,
      () => Promise.reject(new Error('poll failed')),
    );
    const result = poll([p]);
    assert.ok(result instanceof Promise);
    await assert.rejects(result, /poll failed/);
  });
});

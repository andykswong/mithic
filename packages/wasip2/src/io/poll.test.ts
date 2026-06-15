import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pollable, poll } from './poll.ts';

const noop = () => {};

describe('Pollable', () => {
  it('ready() returns true when handler returns true', () => {
    const p = new Pollable(() => true, noop);
    assert.equal(p.ready(), true);
  });

  it('ready() returns false when handler returns false', () => {
    const p = new Pollable(() => false, noop);
    assert.equal(p.ready(), false);
  });

  it('block() returns immediately if ready', () => {
    const p = new Pollable(() => true, noop);
    p.block();
  });

  it('block() calls blockReady until ready (counter-based handler)', () => {
    let counter = 0;
    const p = new Pollable(
      () => counter >= 5,
      () => { counter++; },
    );
    p.block();
    assert.ok(counter >= 5);
  });

  it('timeoutMs() returns undefined when not provided', () => {
    const p = new Pollable(() => true, noop);
    assert.equal(p.timeoutMs(), undefined);
  });

  it('timeoutMs() returns value when provided', () => {
    const p = new Pollable(() => false, noop, () => 42);
    assert.equal(p.timeoutMs(), 42);
  });
});

describe('poll', () => {
  it('throws on empty list', () => {
    assert.throws(() => poll([]), /poll list must not be empty/);
  });

  it('poll([readyPollable]) returns [0]', () => {
    const p = new Pollable(() => true, noop);
    const result = poll([p]) as Uint32Array;
    assert.deepEqual(Array.from(result), [0]);
  });

  it('poll([notReady, ready]) returns [1]', () => {
    const p1 = new Pollable(() => false, noop);
    const p2 = new Pollable(() => true, noop);
    const result = poll([p1, p2]) as Uint32Array;
    assert.deepEqual(Array.from(result), [1]);
  });

  it('poll([ready1, notReady, ready2]) returns [0, 2]', () => {
    const p1 = new Pollable(() => true, noop);
    const p2 = new Pollable(() => false, noop);
    const p3 = new Pollable(() => true, noop);
    const result = poll([p1, p2, p3]) as Uint32Array;
    assert.deepEqual(Array.from(result), [0, 2]);
  });

  it('poll with timer pollable blocks until ready', () => {
    const start = performance.now();
    const buf = new Int32Array(new SharedArrayBuffer(4));
    const p = new Pollable(
      () => performance.now() - start >= 5,
      (maxBlockMs?: number) => {
        const remaining = 5 - (performance.now() - start);
        if (remaining <= 0) return;
        const waitMs = maxBlockMs !== undefined ? Math.min(maxBlockMs, remaining) : remaining;
        Atomics.wait(buf, 0, 0, waitMs);
      },
      () => Math.max(0, 5 - (performance.now() - start)),
    );
    const result = poll([p]) as Uint32Array;
    assert.deepEqual(Array.from(result), [0]);
  });

  it('poll returns Uint32Array', () => {
    const p = new Pollable(() => true, noop);
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
    const p1 = new Pollable(() => true, noop);
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

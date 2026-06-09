import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isThenable, chainMaybePromise, mapMaybePromise } from './types.ts';

describe('isThenable', () => {
  it('returns true for Promises', () => {
    assert.equal(isThenable(Promise.resolve(1)), true);
    assert.equal(isThenable(new Promise(() => {})), true);
  });

  it('returns true for thenable objects', () => {
    assert.equal(isThenable({ then: () => {} }), true);
  });

  it('returns false for null/undefined', () => {
    assert.equal(isThenable(null), false);
    assert.equal(isThenable(undefined), false);
  });

  it('returns false for non-thenable values', () => {
    assert.equal(isThenable(42), false);
    assert.equal(isThenable('hello'), false);
    assert.equal(isThenable({}), false);
    assert.equal(isThenable([]), false);
    assert.equal(isThenable(new Uint8Array(0)), false);
  });

  it('returns false for objects with non-function then', () => {
    assert.equal(isThenable({ then: 'not a function' }), false);
    assert.equal(isThenable({ then: 42 }), false);
  });
});

describe('chainMaybePromise', () => {
  it('chains sync value with sync function', () => {
    const result = chainMaybePromise(5, x => x * 2);
    assert.equal(result, 10);
  });

  it('chains sync value with function returning Promise', async () => {
    const result = chainMaybePromise(5, x => Promise.resolve(x * 3));
    assert(result instanceof Promise);
    assert.equal(await result, 15);
  });

  it('chains Promise value with sync function', async () => {
    const result = chainMaybePromise(Promise.resolve(7), x => x + 1);
    assert(result instanceof Promise);
    assert.equal(await result, 8);
  });

  it('chains Promise value with function returning Promise', async () => {
    const result = chainMaybePromise(Promise.resolve(4), x => Promise.resolve(x * 5));
    assert(result instanceof Promise);
    assert.equal(await result, 20);
  });

  it('propagates sync throw from function', () => {
    assert.throws(
      () => chainMaybePromise(1, () => { throw new Error('fail'); }),
      /fail/,
    );
  });

  it('propagates rejection from Promise input', async () => {
    const result = chainMaybePromise(Promise.reject(new Error('input fail')), x => x);
    await assert.rejects(result, /input fail/);
  });

  it('propagates rejection from function returning rejected Promise', async () => {
    const result = chainMaybePromise(Promise.resolve(1), () => Promise.reject(new Error('fn fail')));
    await assert.rejects(result, /fn fail/);
  });
});

describe('mapMaybePromise', () => {
  it('maps sync value with pure function', () => {
    const result = mapMaybePromise(10, x => x.toString());
    assert.equal(result, '10');
  });

  it('maps Promise value with pure function', async () => {
    const result = mapMaybePromise(Promise.resolve(new Uint8Array([1, 2, 3])), d => d.byteLength);
    assert(result instanceof Promise);
    assert.equal(await result, 3);
  });

  it('propagates sync throw from mapping function', () => {
    assert.throws(
      () => mapMaybePromise(1, () => { throw new Error('map fail'); }),
      /map fail/,
    );
  });

  it('propagates rejection from Promise input', async () => {
    const result = mapMaybePromise(Promise.reject(new Error('reject')), x => x);
    await assert.rejects(result, /reject/);
  });
});

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { immediate, delay } from './delay.ts';

describe('delay', () => {
  beforeEach(() => {
    mock.timers.enable();
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('should return a Promise that resolves after the specified amount of time', async () => {
    const delayMs = 5000;
    const startTime = Date.now();

    const promise = delay(delayMs);
    assert(promise instanceof Promise);

    mock.timers.runAll();

    await promise;
    const elapsedTime = Date.now() - startTime;

    assert(elapsedTime >= delayMs);
  });

  it('should return a Promise that resolves immediately when no delay is provided', async () => {
    const startTime = Date.now();

    const promise = delay();
    assert(promise instanceof Promise);

    mock.timers.runAll();

    await promise;
    const elapsedTime = Date.now() - startTime;

    assert.strictEqual(elapsedTime, 0); // Should resolve immediately with negligible delay
  });

  it('should return a Promise that can be rejected by AbortSignal', async () => {
    mock.timers.reset();
    const controller = new AbortController();
    const signal = controller.signal;
    const delayMs = 1000;

    const promise = delay(delayMs, { signal });
    assert(promise instanceof Promise);

    await assert.rejects(() => {
      controller.abort();
      return promise;
    }, /AbortError/);
  });
});

describe('immediate', () => {
  beforeEach(() => {
    mock.timers.enable();
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('should return a Promise that resolves immediately in next tick', async () => {
    const startTime = Date.now();

    const promise = immediate();
    assert(promise instanceof Promise);

    mock.timers.runAll();

    await promise;
    const elapsedTime = Date.now() - startTime;

    assert.strictEqual(elapsedTime, 0); // Should resolve immediately with negligible delay
  });
});

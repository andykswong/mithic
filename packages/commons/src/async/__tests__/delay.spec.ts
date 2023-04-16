import { jest } from '@jest/globals';
import { immediate, wait } from '../delay.js';

describe(wait.name, () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('should return a Promise that resolves after the specified amount of time', async () => {
    const delayMs = 5000; // 5 seconds
    const startTime = Date.now();

    const promise = wait(delayMs);
    expect(promise).toBeInstanceOf(Promise);

    jest.runAllTimers();

    await promise;
    const elapsedTime = Date.now() - startTime;

    expect(elapsedTime).toBeGreaterThanOrEqual(delayMs);
  });

  it('should return a Promise that resolves immediately when no delay is provided', async () => {
    const startTime = Date.now();

    const promise = wait();
    expect(promise).toBeInstanceOf(Promise);

    jest.runAllTimers();

    await promise;
    const elapsedTime = Date.now() - startTime;

    expect(elapsedTime).toBeLessThan(1); // Should resolve immediately with negligible delay
  });
});

describe(immediate.name, () => {
  it('should return a Promise that resolves immediately in next tick', async () => {
    const startTime = Date.now();

    const promise = immediate();
    expect(promise).toBeInstanceOf(Promise);

    await promise;
    const elapsedTime = Date.now() - startTime;

    expect(elapsedTime).toBeLessThan(1); // Should resolve immediately with negligible delay
  });
});

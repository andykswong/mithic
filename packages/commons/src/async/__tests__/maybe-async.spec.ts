import { describe, expect, it } from '@jest/globals';
import { delay } from '../delay.js';
import { reduce, resolve } from '../maybe-async.js';
import { maybeAsync } from '../promise.js';

describe('resolve', () => {
  it('should work with synchronous values', () => {
    const value = 123;
    const result = maybeAsync(function* () {
      expect(yield* resolve(4)).toEqual(4);
      return value;
    })();
    expect(result).toEqual(value);
  });

  it('should work with Promise', async () => {
    const value = 123;
    const maybeAsyncFn = maybeAsync(function* () {
      yield delay();
      const ten = 1 + (yield* resolve(Promise.resolve(9)));
      expect(ten).toEqual(10);
      return value;
    });

    await expect(maybeAsyncFn()).resolves.toEqual(value);
  });
});

describe('reduce', () => {
  it('should reduce an array of numbers without an initial value', () => {
    const result = maybeAsync(function* () {
      return yield* reduce([1, 2, 3, 4], (a, b) => a + b);
    })();
    expect(result).toEqual(10);
  });

  it('should reduce an array of numbers with an initial value', () => {
    const result = maybeAsync(function* () {
      return yield* reduce([1, 2, 3, 4], (a, b) => a + b, 10);
    })();
    expect(result).toEqual(20);
  });

  it('should reduce an array asynchronously', async () => {
    const result = maybeAsync(function* () {
      const initial = yield* resolve('10');
      return yield* reduce(
        [1, 2, 3, 4],
        async (a, b) => {
          await delay(10);
          return a + b;
        },
        Promise.resolve(+initial)
      );
    })();
    expect(result).resolves.toEqual(20);
  });
});

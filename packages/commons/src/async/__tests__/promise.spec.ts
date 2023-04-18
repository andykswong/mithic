import { jest } from '@jest/globals';
import { isPromiseLike, mapAsync, maybeAsync, MaybePromise, reduceAsync } from '../promise.js';

describe('isPromiseLike', () => {
  test('returns true when given a promise', () => {
    const promise = Promise.resolve();
    expect(isPromiseLike(promise)).toBe(true);
  });

  test('returns true when given a thenable', async () => {
    const thenable = { then() { return; } };
    expect(isPromiseLike(thenable)).toBe(true);
  });

  test('returns false when given null', () => {
    expect(isPromiseLike(null)).toBe(false);
  });

  test('returns false when given an object without a then method', () => {
    const obj = {};
    expect(isPromiseLike(obj)).toBe(false);
  });

  test('returns false when given a non-object', () => {
    expect(isPromiseLike(123)).toBe(false);
    expect(isPromiseLike('hello')).toBe(false);
    expect(isPromiseLike(true)).toBe(false);
  });
});

describe('maybeAsync', () => {
  it('should return the value when the generator function returns synchronously', () => {
    const value = 123;
    const result = maybeAsync(function* () {
      expect(yield 4).toEqual(4);
      return value;
    })();
    expect(result).toEqual(value);
  });

  it('should resolve with the value when the generator function yields a promise', async () => {
    const value = 123;
    const maybeAsyncFn = maybeAsync(function* () {
      const ten = 1 + (yield Promise.resolve(9));
      expect(ten).toEqual(10);
      return value;
    });

    await expect(maybeAsyncFn()).resolves.toEqual(value);
  });

  it('should bind `this` to the generator function', () => {
    const thisArg = { value: 123 };
    const result = maybeAsync(function* (this: typeof thisArg) {
      expect(yield 4).toEqual(4);
      return this.value;
    }, thisArg)();
    expect(result).toEqual(thisArg.value);
  });

  it('should throw an error when the generator function throws', () => {
    const reason = 'test';
    const maybeAsyncFn = maybeAsync(function* () {
      yield 123;
      throw new Error(reason);
    });

    expect(maybeAsyncFn).toThrowError(reason);
  });

  it('should return rejected promise when the generator function throws after async operation', async () => {
    const reason = 'test';
    const maybeAsyncFn = maybeAsync(function* () {
      yield Promise.resolve(123);
      throw new Error(reason);
    });

    await expect(maybeAsyncFn()).rejects.toThrowError(reason);
  });
});

describe('mapAsync', () => {
  test('works with a non-promise value', async () => {
    const result = await mapAsync('hello', val => val.toUpperCase());
    expect(result).toBe('HELLO');
  });

  test('works with a promise value', async () => {
    const result = await mapAsync(Promise.resolve('hello'), val => val.toUpperCase());
    expect(result).toBe('HELLO');
  });

  test('works with a thenable value', async () => {
    const thenable: PromiseLike<string> = {
      then<R1, R2>(
        onfulfilled?: ((value: string) => MaybePromise<R1>),
        onRejected?: ((reason: unknown) => MaybePromise<R2>)
      ) {
        return Promise.resolve('hello').then(onfulfilled, onRejected);
      }
    };
    const result = await mapAsync(thenable, val => val.toUpperCase());
    expect(result).toBe('HELLO');
  });

  test('waits for a promise to resolve before mapping it', async () => {
    const promise = new Promise<string>(resolve => {
      setTimeout(() => resolve('hello'), 1000);
    });
    const result = await mapAsync(promise, val => val.toUpperCase());
    expect(result).toBe('HELLO');
  });

  test('throws an error if the mapValue function throws an error', async () => {
    expect.assertions(2);

    const promise = Promise.resolve('hello');
    const error = new Error('test error');
    const mapper = jest.fn<(value: string) => Promise<void>>().mockRejectedValueOnce(error);

    try {
      await mapAsync(promise, mapper);
    } catch (e) {
      expect(mapper).toHaveBeenCalledWith('hello');
      expect(e).toBe(error);
    }
  });

  test('mapValue function is not executed when value is a rejected promise', async () => {
    expect.assertions(2);

    const error = new Error('test error');
    const promise = Promise.reject(error);
    const mapper = jest.fn<(value: string) => Promise<void>>();

    try {
      await mapAsync(promise, mapper);
    } catch (e) {
      expect(mapper).not.toHaveBeenCalled();
      expect(e).toBe(error);
    }
  });

  test('mapError function is executed when value is a rejected promise', async () => {
    const message = 'ERROR';
    const error = new Error(message);
    const promise = Promise.reject(error);
    const mapValue = jest.fn<(value: string) => Promise<void>>();
    const mapError = jest.fn<(error: unknown) => Promise<string>>(async (error) => (error as Error).message);

    const result = await mapAsync(promise, mapValue, mapError);
    expect(result).toBe(message);
    expect(mapValue).not.toHaveBeenCalled();
    expect(mapError).toHaveBeenCalledWith(error);
  });
});

describe('reduceAsync', () => {
  it('should reduce an array of numbers without an initial value', () => {
    const result = reduceAsync([1, 2, 3, 4], (a, b) => a + b);
    expect(result).toEqual(10);
  });

  it('should reduce an array of numbers with an initial value', () => {
    const result = reduceAsync([1, 2, 3, 4], (a, b) => a + b, 10);
    expect(result).toEqual(20);
  });

  it('should reduce an array asynchronously', async () => {
    const result = reduceAsync(
      [1, 2, 3, 4],
      async (a, b) => a + b,
      Promise.resolve(10)
    );
    expect(result).resolves.toEqual(20);
  });
});

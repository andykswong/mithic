import { jest } from '@jest/globals';
import { isPromiseLike, mapAsync, MaybePromise } from '../promise.js';

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

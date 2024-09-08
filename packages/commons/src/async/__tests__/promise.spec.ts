import { describe, expect, it, jest } from '@jest/globals';
import { MaybePromise } from '../promise.ts';

describe('MaybePromise', () => {
  describe('isThenable', () => {
    it('should return true when given a promise', () => {
      const promise = Promise.resolve();
      expect(MaybePromise.isThenable(promise)).toBe(true);
    });

    it('should return true when given a thenable', async () => {
      const thenable = { then() { return; } };
      expect(MaybePromise.isThenable(thenable)).toBe(true);
    });

    it('should return false when given null', () => {
      expect(MaybePromise.isThenable(null)).toBe(false);
    });

    it('should return false when given an object without a then method', () => {
      const obj = {};
      expect(MaybePromise.isThenable(obj)).toBe(false);
    });

    it('should return false when given a non-object', () => {
      expect(MaybePromise.isThenable(123)).toBe(false);
      expect(MaybePromise.isThenable('hello')).toBe(false);
      expect(MaybePromise.isThenable(true)).toBe(false);
    });
  });

  describe('map', () => {
    it('should work with a non-promise value', async () => {
      const result = await MaybePromise.map('hello', val => val.toUpperCase());
      expect(result).toBe('HELLO');
    });

    it('should work with a promise value', async () => {
      const result = await MaybePromise.map(Promise.resolve('hello'), val => val.toUpperCase());
      expect(result).toBe('HELLO');
    });

    it('should work with a thenable value', async () => {
      const thenable: PromiseLike<string> = {
        then<R1, R2>(
          onfulfilled?: ((value: string) => MaybePromise<R1>),
          onRejected?: ((reason: unknown) => MaybePromise<R2>)
        ) {
          return Promise.resolve('hello').then(onfulfilled, onRejected);
        }
      };
      const result = await MaybePromise.map(thenable, val => val.toUpperCase());
      expect(result).toBe('HELLO');
    });

    it('should wait for a promise to resolve before mapping it', async () => {
      const promise = new Promise<string>(resolve => {
        setTimeout(() => resolve('hello'), 1000);
      });
      const result = await MaybePromise.map(promise, val => val.toUpperCase());
      expect(result).toBe('HELLO');
    });

    it('should throw an error if the mapValue function throws an error', async () => {
      expect.assertions(2);

      const promise = Promise.resolve('hello');
      const error = new Error('test error');
      const mapper = jest.fn<(value: string) => Promise<void>>().mockRejectedValueOnce(error);

      let actualError;
      try {
        await MaybePromise.map(promise, mapper);
      } catch (e) {
        actualError = e;
      }

      expect(mapper).toHaveBeenCalledWith('hello');
      expect(actualError).toBe(error);
    });

    it('should not execute mapValue function when value is a rejected promise', async () => {
      const error = new Error('test error');
      const promise = Promise.reject(error);
      const mapper = jest.fn<(value: string) => Promise<void>>();

      let actualError;
      try {
        await MaybePromise.map(promise, mapper);
      } catch (e) {
        actualError = e;
      }

      expect(actualError).toBe(error);
      expect(mapper).not.toHaveBeenCalled();
    });

    it('should execute mapError function when value is a rejected promise', async () => {
      const message = 'ERROR';
      const error = new Error(message);
      const promise = Promise.reject(error);
      const mapValue = jest.fn<(value: string) => Promise<void>>();
      const mapError = jest.fn<(error: unknown) => Promise<string>>(async (error) => (error as Error).message);

      const result = await MaybePromise.map(promise, mapValue, mapError);
      expect(result).toBe(message);
      expect(mapValue).not.toHaveBeenCalled();
      expect(mapError).toHaveBeenCalledWith(error);
    });
  });

  describe('coroutine', () => {
    it('should return the value when the generator function returns synchronously', () => {
      const value = 123;
      const result = MaybePromise.coroutine(function* () {
        expect(yield 4).toEqual(4);
        return value;
      })();
      expect(result).toEqual(value);
    });

    it('should resolve with the value when the generator function yields a promise', async () => {
      const value = 123;
      const maybeAsyncFn = MaybePromise.coroutine(function* (one: number) {
        const ten = one + (yield Promise.resolve(9));
        expect(ten).toEqual(10);
        return value;
      });

      await expect(maybeAsyncFn(1)).resolves.toEqual(value);
    });

    it('should bind `this` to the generator function', () => {
      const thisArg = { value: 123 };
      const result = MaybePromise.coroutine(function* (this: typeof thisArg) {
        expect(yield 4).toEqual(4);
        return this.value;
      }, thisArg)();
      expect(result).toEqual(thisArg.value);
    });

    it('should throw an error when the generator function throws', () => {
      const reason = 'test';
      expect(MaybePromise.coroutine(function* () {
        yield 123;
        throw new Error(reason);
      })).toThrowError(reason);
    });

    it('should return rejected promise when the generator function throws after async operation', async () => {
      const reason = 'test';
      await expect(MaybePromise.coroutine(function* () {
        yield Promise.resolve(123);
        throw new Error(reason);
      })).rejects.toThrowError(reason);
    });

    it('should throw rejected promise error into generator function', async () => {
      const reason = 'test';
      await expect(MaybePromise.coroutine(function* () {
        try {
          yield Promise.reject(reason);
          return false;
        } catch (e) {
          expect(e).toEqual(reason);
          return yield true;
        }
      })()).resolves.toBe(true);
    });
  });
});

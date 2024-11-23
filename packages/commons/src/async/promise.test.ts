import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { MaybePromise } from './promise.ts';

describe('MaybePromise', () => {
  describe('isThenable', () => {
    it('should return true when given a promise', () => {
      const promise = Promise.resolve();
      assert.strictEqual(MaybePromise.isThenable(promise), true);
    });

    it('should return true when given a thenable', async () => {
      const thenable = { then() { return; } };
      assert.strictEqual(MaybePromise.isThenable(thenable), true);
    });

    it('should return false when given null', () => {
      assert.strictEqual(MaybePromise.isThenable(null), false);
    });

    it('should return false when given an object without a then method', () => {
      const obj = {};
      assert.strictEqual(MaybePromise.isThenable(obj), false);
    });

    it('should return false when given a non-object', () => {
      assert.strictEqual(MaybePromise.isThenable(123), false);
      assert.strictEqual(MaybePromise.isThenable('hello'), false);
      assert.strictEqual(MaybePromise.isThenable(true), false);
    });
  });

  describe('map', () => {
    it('should work with a non-promise value', async () => {
      const result = await MaybePromise.map('hello', val => val.toUpperCase());
      assert.strictEqual(result, 'HELLO');
    });

    it('should work with a promise value', async () => {
      const result = await MaybePromise.map(Promise.resolve('hello'), val => val.toUpperCase());
      assert.strictEqual(result, 'HELLO');
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
      assert.strictEqual(result, 'HELLO');
    });

    it('should wait for a promise to resolve before mapping it', async () => {
      const promise = new Promise<string>(resolve => {
        setTimeout(() => resolve('hello'), 1000);
      });
      const result = await MaybePromise.map(promise, val => val.toUpperCase());
      assert.strictEqual(result, 'HELLO');
    });

    it('should throw an error if the mapValue function throws an error', async () => {
      const promise = Promise.resolve('hello');
      const error = new Error('test error');
      const mapper = mock.fn<(value: string) => Promise<void>>(async () => { throw error; });

      await assert.rejects(async () => {
        await MaybePromise.map(promise, mapper);
      }, error);
      assert.deepStrictEqual(mapper.mock.calls[0].arguments, ['hello']);
    });

    it('should not execute mapValue function when value is a rejected promise', async () => {
      const error = new Error('test error');
      const promise = Promise.reject(error);
      const mapper = mock.fn<(value: string) => Promise<void>>();

      let actualError;
      try {
        await MaybePromise.map(promise, mapper);
      } catch (e) {
        actualError = e;
      }

      assert.strictEqual(actualError, error);
      assert.strictEqual(mapper.mock.callCount(), 0);
    });

    it('should execute mapError function when value is a rejected promise', async () => {
      const message = 'ERROR';
      const error = new Error(message);
      const promise = Promise.reject(error);
      const mapValue = mock.fn<(value: string) => Promise<void>>();
      const mapError = mock.fn<(error: unknown) => Promise<string>>(async (error) => (error as Error).message);

      const result = await MaybePromise.map(promise, mapValue, mapError);
      assert.strictEqual(result, message);
      assert.strictEqual(mapValue.mock.callCount(), 0);
      assert.deepEqual(mapError.mock.calls[0].arguments, [error]);
    });
  });

  describe('all', () => {
    it('should work with non-promise values', () => {
      const input = ['hello', 123, true];
      const result = MaybePromise.all(input);
      assert.deepStrictEqual(result, input);
    });

    it('should work with promise values', async () => {
      const input = ['hello', 123, true];
      const result = MaybePromise.all(input.map((val) => Promise.resolve(val)));
      assert.strictEqual(MaybePromise.isThenable(result), true);
      assert.deepStrictEqual(await result, input);
    });

    it('should work with mixed promise and non-promise values', async () => {
      const input: MaybePromise<string>[] = ['hello', Promise.resolve('world'), '!'];
      const result = MaybePromise.all(input);
      assert.strictEqual(MaybePromise.isThenable(result), true);
      assert.deepStrictEqual(await result, await Promise.all(input));
    });
  });

  describe('coroutine', () => {
    it('should return the value when the generator function returns synchronously', () => {
      const value = 123;
      const result = MaybePromise.coroutine(function* () {
        assert.strictEqual(yield 4, 4);
        return value;
      })();
      assert.strictEqual(result, value);
    });

    it('should resolve with the value when the generator function yields a promise', async () => {
      const value = 123;
      const maybeAsyncFn = MaybePromise.coroutine(function* (one: number) {
        const ten = one + (yield Promise.resolve(9));
        assert.strictEqual(ten, 10);
        return value;
      });

      assert.strictEqual(await maybeAsyncFn(1), value);
    });

    it('should bind `this` to the generator function', () => {
      const thisArg = { value: 123 };
      const result = MaybePromise.coroutine(function* (this: typeof thisArg) {
        assert.strictEqual(yield 4, 4);
        return this.value;
      }, thisArg)();
      assert.strictEqual(result, thisArg.value);
    });

    it('should throw an error when the generator function throws', () => {
      const reason = 'test';
      assert.throws(MaybePromise.coroutine(function* () {
        yield 123;
        throw new Error(reason);
      }), /test/);
    });

    it('should return rejected promise when the generator function throws after async operation', async () => {
      const reason = 'test';
      await assert.rejects(async () => {
        await MaybePromise.coroutine(function* () {
          yield Promise.resolve(123);
          throw new Error(reason);
        })();
      }, /test/);
    });

    it('should throw rejected promise error into generator function', async () => {
      const reason = 'test';
      assert.strictEqual(await MaybePromise.coroutine(function* () {
        try {
          yield Promise.reject(reason);
          return false;
        } catch (e) {
          assert.deepStrictEqual(e, reason);
          return yield true;
        }
      })(), true);
    });
  });
});

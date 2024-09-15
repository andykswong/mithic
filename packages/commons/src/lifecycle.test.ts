import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { dispose } from './index.ts';

describe('dispose', () => {
  it('should work for non-disposables', () => {
    dispose(undefined);
    dispose({});
  });

  it('should call Symbol.dispose', () => {
    const test = new class Test implements Disposable {
      public [Symbol.dispose](): void {
      }
    }();
    const disposeSpy = mock.method(test, Symbol.dispose);
    dispose(test);
    assert.strictEqual(disposeSpy.mock.callCount(), 1);
  });

  it('should call Symbol.asyncDispose', async () => {
    const expected = Promise.resolve();
    const test = new class Test implements AsyncDisposable {
      public [Symbol.asyncDispose](): Promise<void> {
        return expected;
      }
    }();
    const result = dispose(test);
    assert.strictEqual(result, expected);
  });
});

import { describe, expect, it, jest } from '@jest/globals';
import { dispose } from '../lifecycle.ts';

describe(dispose.name, () => {
  it('should work for non-disposables', () => {
    dispose(undefined);
    dispose({});
  });

  it('should call Symbol.dispose', () => {
    const test = new class Test implements Disposable {
      public [Symbol.dispose](): void {
      }
    }();
    const disposeSpy = jest.spyOn(test, Symbol.dispose);
    dispose(test);
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('should call Symbol.asyncDispose', async () => {
    const expected = Promise.resolve();
    const test = new class Test implements AsyncDisposable {
      public [Symbol.asyncDispose](): Promise<void> {
        return expected;
      }
    }();
    const result = dispose(test);
    expect(result).toBe(expected);
  });

});

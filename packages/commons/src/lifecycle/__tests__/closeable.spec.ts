import { describe, expect, it, jest } from '@jest/globals';
import { delay } from '../../async/index.js';
import { AsyncDisposableCloseable, DisposableCloseable } from '../closeable.js';

describe(AsyncDisposableCloseable.name, () => {
  it('should await close() on dispose', async () => {
    class Test extends AsyncDisposableCloseable {
      public override async close(): Promise<void> {
        await delay();
      }
    }

    const test = new Test();
    const closeSpy = jest.spyOn(test, 'close');
    await test[Symbol.asyncDispose]();
    expect(closeSpy).toHaveBeenCalled();
  });
});

describe(DisposableCloseable.name, () => {
  it('should close() on dispose', () => {
    class Test extends DisposableCloseable {
      public override close(): void {
      }
    }

    const test = new Test();
    const closeSpy = jest.spyOn(test, 'close');
    test[Symbol.dispose]();
    expect(closeSpy).toHaveBeenCalled();
  });
});

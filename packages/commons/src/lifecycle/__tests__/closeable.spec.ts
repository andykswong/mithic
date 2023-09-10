import { delay } from '../../async/index.js';
import { AsyncDisposableCloseable, DisposableCloseable } from '../closeable.js';

describe(AsyncDisposableCloseable.name, () => {
  it('should await close() on dispose', async () => {
    expect.assertions(1);

    class Test extends AsyncDisposableCloseable {
      public override async close(): Promise<void> {
        await delay();
        expect(true).toBe(true);
      }
    }

    const test = new Test();
    await test[Symbol.asyncDispose]();
  });
});

describe(DisposableCloseable.name, () => {
  it('should close() on dispose', () => {
    expect.assertions(1);

    class Test extends DisposableCloseable {
      public override close(): void {
        expect(true).toBe(true);
      }
    }

    const test = new Test();
    test[Symbol.dispose]();
  });
});

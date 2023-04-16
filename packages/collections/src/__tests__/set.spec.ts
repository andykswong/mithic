import { MaybeAsyncSet } from '../set.js';

describe('MaybeAsyncSet', () => {
  it('should be compatible with ES Set', () => {
    const _: MaybeAsyncSet<string> = new Set();
  });
});

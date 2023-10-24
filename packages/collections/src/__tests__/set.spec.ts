import { describe, it } from '@jest/globals';
import { MaybeAsyncSet } from '../set.js';

describe('MaybeAsyncSet', () => {
  it('should be compatible with ES Set', () => {
    const _ = new Set<string>() satisfies MaybeAsyncSet<string>;
  });
});

import { describe, it } from '@jest/globals';
import { MaybeAsyncMap } from '../map.js';

describe('MaybeAsyncMap', () => {
  it('should be compatible with ES Map', () => {
    const _ = new Map<string, number>() satisfies MaybeAsyncMap<string, number>;
  });
});

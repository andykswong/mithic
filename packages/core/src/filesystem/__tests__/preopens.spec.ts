import { describe, expect, it } from '@jest/globals';
import { getDirectories } from '../preopens.ts';

describe('preopens', () => {
  describe('getDirectories', () => {
    it('should return empty list', () => {
      expect(getDirectories()).toEqual([]);
    });
  });
});

import { describe, expect, it } from '@jest/globals';
import { IdentityCodec } from '../codec.js';

describe('IdentityCodec', () => {
  describe('encode', () => {
    it('should return data unchanged', () => {
      const data = 'data';
      expect(IdentityCodec.encode(data)).toBe(data);
    });
  });

  describe('decode', () => {
    it('should return data unchanged', () => {
      const data = 'data';
      expect(IdentityCodec.decode(data)).toBe(data);
    });
  });
});

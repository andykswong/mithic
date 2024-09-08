import { beforeEach, describe, expect, it } from '@jest/globals';
import { IdentityCodec, TextCodec, type Decoder, type Encoder } from '../codec.ts';

describe('Encoder', () => {
  it('should be compatible with TextEncoder', () => {
    const _: Encoder<string> = new TextEncoder();
  });
});

describe('Decoder', () => {
  it('should be compatible with TextDecoder', () => {
    const _: Decoder<string> = new TextDecoder();
  });
});

describe('TextCodec', () => {
  let codec: TextCodec;

  beforeEach(() => {
    codec = new TextCodec();
  })

  describe('encode', () => {
    it('should return string encoded', () => {
      const str = 'abc';
      const encodedStr = new TextEncoder().encode(str);
      expect(codec.encode(str)).toEqual(encodedStr);
    });
  });

  describe('decode', () => {
    it('should return decoded string', () => {
      const str = 'testing';
      const encodedStr = new TextEncoder().encode(str);
      expect(codec.decode(encodedStr)).toBe(str);
    });
  });
});

describe('IdentityCodec', () => {
  describe('encode', () => {
    it('should return data unchanged', () => {
      const data = new Uint8Array([1, 2, 3]);
      expect(IdentityCodec.encode(data)).toEqual(data);
    });
  });

  describe('decode', () => {
    it('should return data unchanged', () => {
      const data = new Uint8Array([4, 5]);
      expect(IdentityCodec.decode(data)).toBe(data);
    });
  });
});

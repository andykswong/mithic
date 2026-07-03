import { expect, test, describe } from 'vitest';
import { sha224, sha224hex } from './_sha224.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('_sha224 (pure-TS SHA-224, FIPS 180-4)', () => {
  test('empty input', () => {
    expect(sha224hex(new Uint8Array())).toBe('d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f');
  });

  test('"abc" (FIPS 180-4 one-block vector)', () => {
    expect(sha224hex(enc('abc'))).toBe('23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
  });

  test('56-byte two-block vector', () => {
    expect(sha224hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))
      .toBe('75388b16512776cc5dba5da1fd890150b0c6455cb4f58b1952522525');
  });

  test('"hello world\\n" matches GNU cksum -a sha224', () => {
    expect(sha224hex(enc('hello world\n'))).toBe('95041dd60ab08c0bf5636d50be85fe9790300f39eb84602858a9b430');
  });

  test('pangram', () => {
    expect(sha224hex(enc('The quick brown fox jumps over the lazy dog')))
      .toBe('730e109bd7a8a32b1cb9d9a09aa2325d2430587ddbc0c38bad911525');
  });

  test('one million "a" (multi-block, length-append)', () => {
    expect(sha224hex(new Uint8Array(1000000).fill(0x61)))
      .toBe('20794655980c91d8bbb4c1ea97618a4bf03f42581948b2ee4ee7ad67');
  });

  test('digest is 28 bytes', () => {
    expect(sha224(enc('abc')).length).toBe(28);
  });
});

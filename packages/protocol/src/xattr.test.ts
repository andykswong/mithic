import { describe, it, expect } from 'vitest';
import { SECURITY_CAPABILITY_XATTR, encodeCapabilities, decodeCapabilities } from './xattr.ts';
import type { Capability } from './process.ts';

describe('security.capability xattr', () => {
  it('exposes the well-known name', () => {
    expect(SECURITY_CAPABILITY_XATTR).toBe('security.capability');
  });

  it('round-trips a Capability[]', () => {
    const caps: Capability[] = [
      { type: 'fs', paths: ['/in', '/out'], operations: ['read', 'write'] },
      { type: 'process', maxChildren: 4 },
    ];
    const bytes = encodeCapabilities(caps);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decodeCapabilities(bytes)).toEqual(caps);
  });

  it('round-trips every Capability variant', () => {
    const caps: Capability[] = [
      { type: 'fs', paths: ['/usr/bin/resize'], operations: ['read', 'write', 'execute'] },
      { type: 'net', origins: ['https://example.com'] },
      { type: 'ipc', channels: ['ch1', 'ch2'] },
      { type: 'process' },
      { type: 'env' },
    ];
    expect(decodeCapabilities(encodeCapabilities(caps))).toEqual(caps);
  });

  it('round-trips an empty Capability[] (encode → decode)', () => {
    const bytes = encodeCapabilities([]);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decodeCapabilities(bytes)).toEqual([]);
  });

  it('decodes empty/garbage to [] (default-deny)', () => {
    expect(decodeCapabilities(undefined)).toEqual([]);
    expect(decodeCapabilities(new Uint8Array([1, 2, 3]))).toEqual([]);
  });

  it('decodes a zero-length buffer to [] (default-deny)', () => {
    expect(decodeCapabilities(new Uint8Array(0))).toEqual([]);
  });

  it('decodes valid JSON that is not an array to [] (default-deny)', () => {
    const obj = new TextEncoder().encode(JSON.stringify({ type: 'fs' }));
    expect(decodeCapabilities(obj)).toEqual([]);
    const scalar = new TextEncoder().encode(JSON.stringify('fs'));
    expect(decodeCapabilities(scalar)).toEqual([]);
    const nul = new TextEncoder().encode(JSON.stringify(null));
    expect(decodeCapabilities(nul)).toEqual([]);
  });

  it('decodes truncated/invalid UTF-8 JSON to [] (default-deny)', () => {
    expect(decodeCapabilities(new TextEncoder().encode('[{"type":'))).toEqual([]);
  });

  it('encoded bytes are valid UTF-8 JSON of the input', () => {
    const caps: Capability[] = [{ type: 'env' }];
    const text = new TextDecoder().decode(encodeCapabilities(caps));
    expect(JSON.parse(text)).toEqual(caps);
  });

  const encode = (value: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(value));

  it('rejects the whole array if any element has an unknown type (default-deny)', () => {
    expect(decodeCapabilities(encode([{ type: 'bogus' }]))).toEqual([]);
    expect(decodeCapabilities(encode([
      { type: 'env' },
      { type: 'bogus' },
    ]))).toEqual([]);
  });

  it('rejects the whole array if any element is not an object (default-deny)', () => {
    expect(decodeCapabilities(encode([42, 'x']))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'env' }, null]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'env' }, []]))).toEqual([]);
  });

  it('rejects fs caps missing or mistyped required fields (default-deny)', () => {
    expect(decodeCapabilities(encode([{ type: 'fs' }]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'fs', paths: ['/x'] }]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'fs', operations: ['read'] }]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'fs', paths: 'x', operations: ['read'] }]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'fs', paths: [1], operations: ['read'] }]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'fs', paths: ['/x'], operations: ['delete'] }]))).toEqual([]);
  });

  it('rejects net caps with mistyped origins (default-deny)', () => {
    expect(decodeCapabilities(encode([{ type: 'net' }]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'net', origins: 'x' }]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'net', origins: [1] }]))).toEqual([]);
  });

  it('rejects ipc caps with mistyped channels (default-deny)', () => {
    expect(decodeCapabilities(encode([{ type: 'ipc' }]))).toEqual([]);
    expect(decodeCapabilities(encode([{ type: 'ipc', channels: [1] }]))).toEqual([]);
  });

  it('rejects process caps with a mistyped maxChildren (default-deny)', () => {
    expect(decodeCapabilities(encode([{ type: 'process', maxChildren: 'lots' }]))).toEqual([]);
  });

  it('accepts process caps with or without maxChildren', () => {
    expect(decodeCapabilities(encode([{ type: 'process' }]))).toEqual([{ type: 'process' }]);
    expect(decodeCapabilities(encode([{ type: 'process', maxChildren: 4 }])))
      .toEqual([{ type: 'process', maxChildren: 4 }]);
  });

  it('accepts a well-formed array of every variant', () => {
    const caps: Capability[] = [
      { type: 'fs', paths: ['/usr/bin'], operations: ['read', 'write', 'execute'] },
      { type: 'net', origins: ['https://example.com'] },
      { type: 'ipc', channels: ['ch1'] },
      { type: 'process', maxChildren: 2 },
      { type: 'env' },
    ];
    expect(decodeCapabilities(encode(caps))).toEqual(caps);
  });
});

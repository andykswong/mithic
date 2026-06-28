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
});

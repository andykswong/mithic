import { expect, test, describe } from 'vitest';
import { encodeCapabilities, SECURITY_CAPABILITY_XATTR } from '@mithic/protocol';
import type { Capability } from '@mithic/protocol';
import { getcapCommand } from './getcap.ts';
import { setcapCommand, parseCapSpec } from './setcap.ts';
import { makeIO } from './_testio.ts';

describe('setcap spec parser', () => {
  test('fs with one op and one path', () => {
    expect(parseCapSpec('fs:read:/x')).toEqual([
      { type: 'fs', operations: ['read'], paths: ['/x'] },
    ]);
  });
  test('fs with multiple ops and paths', () => {
    expect(parseCapSpec('fs:read,write:/in,/out')).toEqual([
      { type: 'fs', operations: ['read', 'write'], paths: ['/in', '/out'] },
    ]);
  });
  test('net origins', () => {
    expect(parseCapSpec('net:https://a.example,https://b.example')).toEqual([
      { type: 'net', origins: ['https://a.example', 'https://b.example'] },
    ]);
  });
  test('process with maxChildren', () => {
    expect(parseCapSpec('process:4')).toEqual([{ type: 'process', maxChildren: 4 }]);
  });
  test('process without maxChildren', () => {
    expect(parseCapSpec('process')).toEqual([{ type: 'process' }]);
  });
  test('env (no detail)', () => {
    expect(parseCapSpec('env')).toEqual([{ type: 'env' }]);
  });
  test('ipc channels', () => {
    expect(parseCapSpec('ipc:a,b')).toEqual([{ type: 'ipc', channels: ['a', 'b'] }]);
  });
  test('multiple caps separated by ;', () => {
    expect(parseCapSpec('fs:read:/x;net:https://a.example')).toEqual([
      { type: 'fs', operations: ['read'], paths: ['/x'] },
      { type: 'net', origins: ['https://a.example'] },
    ]);
  });
  test('whitespace tolerance', () => {
    expect(parseCapSpec(' fs : read , write : /in , /out ')).toEqual([
      { type: 'fs', operations: ['read', 'write'], paths: ['/in', '/out'] },
    ]);
  });
  test('unknown type throws', () => {
    expect(() => parseCapSpec('bogus:x')).toThrow();
  });
  test('invalid fs operation throws', () => {
    expect(() => parseCapSpec('fs:bogus:/x')).toThrow();
  });
  test('fs missing paths throws', () => {
    expect(() => parseCapSpec('fs:read')).toThrow();
  });
  test('empty spec throws', () => {
    expect(() => parseCapSpec('')).toThrow();
  });
});

describe('getcap', () => {
  test('prints decoded caps for a file with a security.capability xattr', async () => {
    const caps: Capability[] = [
      { type: 'fs', paths: ['/in', '/out'], operations: ['read', 'write'] },
      { type: 'process', maxChildren: 4 },
    ];
    const h = makeIO({
      args: ['getcap', '/f'],
      files: { '/f': 'x' },
      xattrs: { '/f': { [SECURITY_CAPABILITY_XATTR]: encodeCapabilities(caps) } },
    });
    expect(await getcapCommand(h.io)).toBe(0);
    expect(h.out()).toContain('/f');
    expect(h.out()).toContain('fs');
    expect(h.out()).toContain('read');
    expect(h.out()).toContain('write');
    expect(h.out()).toContain('process');
  });

  test('a file with no capability xattr reports an empty grant (no caps)', async () => {
    const h = makeIO({ args: ['getcap', '/f'], files: { '/f': 'x' } });
    expect(await getcapCommand(h.io)).toBe(0);
    expect(h.out()).not.toContain('fs');
  });

  test('missing operand errors', async () => {
    const h = makeIO({ args: ['getcap'] });
    expect(await getcapCommand(h.io)).toBe(1);
    expect(h.err()).toContain('getcap');
  });

  test('nonexistent file errors', async () => {
    const h = makeIO({ args: ['getcap', '/missing'] });
    expect(await getcapCommand(h.io)).toBe(1);
    expect(h.err()).toMatch(/missing|No such/i);
  });
});

describe('setcap', () => {
  test('sets a capability that getcap then reflects', async () => {
    const h = makeIO({ args: ['setcap', 'fs:read:/x', '/f'], files: { '/f': 'x' } });
    expect(await setcapCommand(h.io)).toBe(0);

    const stored = await h.fs.getxattr('/f', SECURITY_CAPABILITY_XATTR);
    expect(stored).toBeInstanceOf(Uint8Array);

    const g = makeIO({
      args: ['getcap', '/f'],
      files: { '/f': 'x' },
      xattrs: { '/f': { [SECURITY_CAPABILITY_XATTR]: stored! } },
    });
    expect(await getcapCommand(g.io)).toBe(0);
    expect(g.out()).toContain('fs');
    expect(g.out()).toContain('read');
    expect(g.out()).toContain('/x');
  });

  test('round-trips a multi-cap spec', async () => {
    const h = makeIO({
      args: ['setcap', 'fs:read,write:/in,/out;process:2', '/f'],
      files: { '/f': 'x' },
    });
    expect(await setcapCommand(h.io)).toBe(0);
    const { decodeCapabilities } = await import('@mithic/protocol');
    const stored = await h.fs.getxattr('/f', SECURITY_CAPABILITY_XATTR);
    expect(decodeCapabilities(stored)).toEqual([
      { type: 'fs', operations: ['read', 'write'], paths: ['/in', '/out'] },
      { type: 'process', maxChildren: 2 },
    ]);
  });

  test('missing operand errors', async () => {
    const h = makeIO({ args: ['setcap', 'fs:read:/x'] });
    expect(await setcapCommand(h.io)).toBe(1);
    expect(h.err()).toContain('setcap');
  });

  test('invalid spec errors with non-zero exit', async () => {
    const h = makeIO({ args: ['setcap', 'bogus:x', '/f'], files: { '/f': 'x' } });
    expect(await setcapCommand(h.io)).toBe(1);
    expect(h.err()).toContain('setcap');
  });

  test('nonexistent file errors', async () => {
    const h = makeIO({ args: ['setcap', 'fs:read:/x', '/missing'] });
    expect(await setcapCommand(h.io)).toBe(1);
  });
});

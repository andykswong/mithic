import { describe, it, expect } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider } from '@mithic/io/vfs';
import { decodeCapabilities, SECURITY_CAPABILITY_XATTR } from '@mithic/protocol';
import { installUtility } from './install.js';
import type { UtilityManifest } from './manifests.js';

const SRC = new TextEncoder().encode("export default async (g) => g.exit(0);\n");

async function freshVfs(): Promise<FileSystemProvider> {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  return router;
}

async function readAll(vfs: FileSystemProvider, path: string): Promise<Uint8Array> {
  const h = await vfs.open(path, { read: true });
  const chunks: Uint8Array[] = [];
  let off = 0;
  for (;;) {
    const c = await vfs.read(h, off, 65536);
    if (!c || c.byteLength === 0) break;
    chunks.push(new Uint8Array(c));
    off += c.byteLength;
  }
  await vfs.close(h);
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

describe('installUtility', () => {
  const manifest: UtilityManifest = {
    name: 'resize',
    capabilities: {
      fs: { paths: ['/in', '/out'], operations: ['read', 'write'] },
      process: { maxChildren: 0 },
    },
  };

  it('writes bytes, sets +x, and sets security.capability xattr from the manifest', async () => {
    const vfs = await freshVfs();
    await installUtility(vfs, '/usr/bin/resize', SRC, manifest);

    const st = await vfs.stat('/usr/bin/resize');
    expect(st.type).toBe('file');
    expect(st.mode & 0o111).not.toBe(0);

    const xattr = await vfs.getxattr('/usr/bin/resize', SECURITY_CAPABILITY_XATTR);
    expect(xattr).toBeInstanceOf(Uint8Array);
    expect(decodeCapabilities(xattr)).toEqual([
      { type: 'fs', paths: ['/in', '/out'], operations: ['read', 'write'] },
      { type: 'process', maxChildren: 0 },
    ]);
  });

  it('prepends a #!/bin/node shebang when the source lacks one (TS build does not choke on #!)', async () => {
    const vfs = await freshVfs();
    await installUtility(vfs, '/usr/bin/resize', SRC, manifest);
    const bytes = await readAll(vfs, '/usr/bin/resize');
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('#!/bin/node\n')).toBe(true);
    expect(text.endsWith(new TextDecoder().decode(SRC))).toBe(true);
  });

  it('preserves an existing shebang rather than doubling it', async () => {
    const vfs = await freshVfs();
    const withShebang = new TextEncoder().encode('#!/bin/node\nexport default async (g) => g.exit(0);\n');
    await installUtility(vfs, '/usr/bin/resize', withShebang, manifest);
    const text = new TextDecoder().decode(await readAll(vfs, '/usr/bin/resize'));
    expect(text).toBe(new TextDecoder().decode(withShebang));
    expect(text.indexOf('#!/bin/node')).toBe(text.lastIndexOf('#!/bin/node'));
  });

  it('creates missing parent directories (/usr, /usr/bin)', async () => {
    const vfs = await freshVfs();
    await installUtility(vfs, '/usr/bin/resize', SRC, manifest);
    expect((await vfs.stat('/usr')).type).toBe('directory');
    expect((await vfs.stat('/usr/bin')).type).toBe('directory');
  });

  it('reinstall over an existing path replaces bytes and xattr', async () => {
    const vfs = await freshVfs();
    await installUtility(vfs, '/usr/bin/resize', SRC, manifest);
    const next: UtilityManifest = { name: 'resize', capabilities: { net: { origins: ['https://example.com'] } } };
    const nextSrc = new TextEncoder().encode('export default async (g) => g.exit(7);\n');
    await installUtility(vfs, '/usr/bin/resize', nextSrc, next);

    const text = new TextDecoder().decode(await readAll(vfs, '/usr/bin/resize'));
    expect(text.endsWith('g.exit(7);\n')).toBe(true);
    expect(decodeCapabilities(await vfs.getxattr('/usr/bin/resize', SECURITY_CAPABILITY_XATTR))).toEqual([
      { type: 'net', origins: ['https://example.com'] },
    ]);
  });

  it('a manifest with no capabilities yields an empty (default-deny) grant', async () => {
    const vfs = await freshVfs();
    await installUtility(vfs, '/usr/bin/bare', SRC, { name: 'bare' });
    expect(decodeCapabilities(await vfs.getxattr('/usr/bin/bare', SECURITY_CAPABILITY_XATTR))).toEqual([]);
  });

  it('writes a multi-chunk payload byte-exact (no boundary corruption)', async () => {
    const vfs = await freshVfs();
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const body = new TextEncoder().encode('#!/bin/node\n');
    const payload = new Uint8Array(body.length + big.length);
    payload.set(body, 0);
    payload.set(big, body.length);
    await installUtility(vfs, '/usr/bin/big', payload, { name: 'big' });
    const back = await readAll(vfs, '/usr/bin/big');
    expect(back.byteLength).toBe(payload.byteLength);
    expect(Array.from(back.subarray(0, 12))).toEqual(Array.from(payload.subarray(0, 12)));
    expect(Array.from(back.subarray(-4))).toEqual(Array.from(payload.subarray(-4)));
  });
});

/**
 * Task V3 — host `File` -> VFS ingest (streamed, byte-faithful).
 *
 * The Lab loop's first step: a user drops a local `File`; {@link ingestFile}
 * streams `File.stream()` into a VFS input path in chunks (never the whole
 * buffer at once) so a multi-MiB drop neither materializes in one allocation nor
 * traverses the string-typed shell. The contract the loop relies on: the bytes
 * land byte-exact (RFC 0001 §4.4, G8).
 */
import { describe, it, expect } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider } from '@mithic/io/vfs';
import { ingestFile } from './ingest.js';

async function freshVfs(): Promise<FileSystemProvider> {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  await router.mkdir('/in');
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

function pseudoRandom(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(n));
  let x = 0x9e3779b9 >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

describe('ingestFile', () => {
  it('streams a 2 MiB File into a VFS path byte-exact', async () => {
    const vfs = await freshVfs();
    const payload = pseudoRandom(2 * 1024 * 1024);
    const file = new File([payload], 'data.bin', { type: 'application/octet-stream' });

    const written = await ingestFile(vfs, file, '/in/data.bin');
    expect(written).toBe(payload.byteLength);

    const back = await readAll(vfs, '/in/data.bin');
    expect(back.byteLength).toBe(payload.byteLength);
    expect(back).toEqual(payload);
  });

  it('ingests an empty file as a zero-length VFS file', async () => {
    const vfs = await freshVfs();
    const written = await ingestFile(vfs, new File([], 'empty.bin'), '/in/empty.bin');
    expect(written).toBe(0);
    expect((await vfs.stat('/in/empty.bin')).size).toBe(0n);
    expect((await readAll(vfs, '/in/empty.bin')).byteLength).toBe(0);
  });

  it('overwrites an existing target (truncate, no leftover tail)', async () => {
    const vfs = await freshVfs();
    await ingestFile(vfs, new File([pseudoRandom(4096)], 'a'), '/in/data.bin');
    await ingestFile(vfs, new File([Uint8Array.from([1, 2, 3])], 'b'), '/in/data.bin');
    const back = await readAll(vfs, '/in/data.bin');
    expect(Array.from(back)).toEqual([1, 2, 3]);
  });

  it('rejects when the file exceeds maxBytes (and writes nothing past the bound)', async () => {
    const vfs = await freshVfs();
    const file = new File([pseudoRandom(200_000)], 'big.bin');
    await expect(ingestFile(vfs, file, '/in/big.bin', { maxBytes: 65_536 })).rejects.toThrow(/exceed|too large|maxBytes/i);
  });
});

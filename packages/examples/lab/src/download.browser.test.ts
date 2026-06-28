/**
 * Task V3 — VFS -> host download (streamed, byte-faithful).
 *
 * The Lab loop's last step: a result file at a VFS path is read out to a `Blob`
 * the host can hand the user. {@link readVfsToBlob} reads the file in chunks
 * (never the whole buffer at once) so a multi-MiB result neither materializes in
 * one allocation nor passes through the shell. {@link triggerDownload} is the
 * thin anchor-click helper that turns that `Blob` into a browser download
 * (RFC 0001 §4.4, G9).
 */
import { describe, it, expect } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import { readVfsToBlob, triggerDownload } from './download.js';

async function freshVfs(): Promise<FileSystemProvider> {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  await router.mkdir('/out');
  return router;
}

async function seed(vfs: FileSystemProvider, path: string, bytes: Uint8Array): Promise<void> {
  const h = (await vfs.open(path, { write: true, create: true, truncate: true })) as FileHandle;
  for (let off = 0; off < bytes.byteLength; off += 65536) {
    await vfs.write(h, bytes.subarray(off, off + 65536), off);
  }
  await vfs.close(h);
}

function pseudoRandom(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  let x = 0x12345678 >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

describe('readVfsToBlob', () => {
  it('reads a >64 KiB file into a byte-identical Blob', async () => {
    const vfs = await freshVfs();
    const payload = pseudoRandom(256 * 1024);
    await seed(vfs, '/out/data.bin', payload);

    const blob = await readVfsToBlob(vfs, '/out/data.bin');
    expect(blob.size).toBe(payload.byteLength);
    const back = new Uint8Array(await blob.arrayBuffer());
    expect(back).toEqual(payload);
  });

  it('reads an empty file into a zero-length Blob', async () => {
    const vfs = await freshVfs();
    await seed(vfs, '/out/empty.bin', new Uint8Array(0));
    const blob = await readVfsToBlob(vfs, '/out/empty.bin');
    expect(blob.size).toBe(0);
  });

  it('applies the supplied MIME type to the Blob', async () => {
    const vfs = await freshVfs();
    await seed(vfs, '/out/photo.webp', new Uint8Array([1, 2, 3, 4]));
    const blob = await readVfsToBlob(vfs, '/out/photo.webp', { type: 'image/webp' });
    expect(blob.type).toBe('image/webp');
  });
});

describe('triggerDownload', () => {
  it('clicks a transient anchor wired to an object URL named after the download', () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const created: string[] = [];
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((b: Blob) => { const u = `blob:test-${created.length}`; created.push(u); void b; return u; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((u: string) => { revoked.push(u); }) as typeof URL.revokeObjectURL;

    let clicked: { href: string; download: string } | undefined;
    const realCreateElement = document.createElement.bind(document);
    const spy = (tag: string) => {
      const el = realCreateElement(tag) as HTMLAnchorElement;
      if (tag === 'a') {
        el.click = () => { clicked = { href: el.href, download: el.download }; };
      }
      return el;
    };
    document.createElement = spy as typeof document.createElement;

    try {
      triggerDownload(blob, 'result.bin');
    } finally {
      document.createElement = realCreateElement as typeof document.createElement;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }

    expect(clicked).toBeDefined();
    expect(clicked!.download).toBe('result.bin');
    expect(created).toHaveLength(1);
    expect(clicked!.href).toContain(created[0]);
    expect(revoked).toEqual(created);
  });
});

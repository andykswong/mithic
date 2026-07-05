/**
 * Task V5 (RFC 0001 §4.5, G17 + D4): the Lab preview pane.
 *
 * A result file at a VFS path is turned into a host-created `blob:` object URL
 * and mounted as an `<img>` inside the per-window {@link RemoteDomHost}
 * container. It PAINTS because the host page's CSP permits `blob:` (the iframe's
 * does not — D4), and the Remote-DOM allowlist already permits `img` + `src`.
 *
 * Browser-only: `RemoteDomHost` applies mutations to a real DOM, `URL.createObjectURL`
 * mints a `blob:` URL, and an `<img>` decode needs a layout engine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteDomHost } from '@mithic/kernel';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import { previewResult } from './preview.js';

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers) c.remove();
  containers.length = 0;
});

function freshContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  containers.push(el);
  return el;
}

async function freshVfs(): Promise<FileSystemProvider> {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  await router.mkdir('/out');
  return router;
}

async function seed(vfs: FileSystemProvider, path: string, bytes: Uint8Array): Promise<void> {
  const h = (await vfs.open(path, { write: true, create: true, truncate: true })) as FileHandle;
  await vfs.write(h, bytes, 0);
  await vfs.close(h);
}

/** A real, decodable PNG so the `<img>` actually paints (proves `blob:` is allowed). */
async function fixturePng(width = 8, height = 8): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

describe('previewResult', () => {
  it('mounts an <img> with a blob: src that decodes (the host CSP permits blob:)', async () => {
    const vfs = await freshVfs();
    const container = freshContainer();
    const host = new RemoteDomHost({ container });

    await seed(vfs, '/out/photo.png', await fixturePng(8, 8));
    const url = await previewResult(host, vfs, '/out/photo.png');

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(url);
    expect(url.startsWith('blob:')).toBe(true);

    // It really paints — a broken src would never reach naturalWidth > 0.
    await img!.decode();
    expect(img!.naturalWidth).toBe(8);

    URL.revokeObjectURL(url);
  });

  it('infers the blob MIME from the path extension', async () => {
    const vfs = await freshVfs();
    const container = freshContainer();
    const host = new RemoteDomHost({ container });
    await seed(vfs, '/out/photo.webp', await fixturePng(4, 4));

    // A previewResult that hands back the URL is enough; the Blob type is what
    // makes <img> treat it as an image — assert via a fetched Blob.
    const url = await previewResult(host, vfs, '/out/photo.webp');
    const blob = await (await fetch(url)).blob();
    expect(blob.type).toBe('image/webp');
    URL.revokeObjectURL(url);
  });

  it('replaces a prior preview rather than appending (one <img> per pane)', async () => {
    const vfs = await freshVfs();
    const container = freshContainer();
    const host = new RemoteDomHost({ container });
    await seed(vfs, '/out/a.png', await fixturePng(8, 8));
    await seed(vfs, '/out/b.png', await fixturePng(8, 8));

    const u1 = await previewResult(host, vfs, '/out/a.png');
    const u2 = await previewResult(host, vfs, '/out/b.png');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(u2);
    URL.revokeObjectURL(u1);
    URL.revokeObjectURL(u2);
  });
});

describe('the RemoteDomHost sanitizer the preview rides on', () => {
  it('rejects hostile/remote img srcs (§9 rule 3); blob: and inert data:image pass', () => {
    const container = freshContainer();
    const host = new RemoteDomHost({ container });
    // Build an <img> directly via mutations and try to set hostile srcs.
    host.applyMutations([
      { type: 'createElement', id: 1, tag: 'img' },
      { type: 'appendChild', parentId: 0, childId: 1 },
    ]);
    const img = container.querySelector('img')!;

    for (const hostile of [
      'javascript:alert(1)',
      'vbscript:msgbox(1)',
      // §9 rule 3: RemoteDomHost renders in the HOST page (no CSP) — a REMOTE src is a
      // host-origin GET-exfil channel, so remote origins are rejected here.
      'https://evil.example/beacon?x=1',
      'http://evil.example/x',
      '//evil.example/x',
      // SVG data: can script (<svg onload=…>), so it is NOT an inert image — rejected.
      'data:image/svg+xml,<svg onload=alert(1)>',
    ]) {
      const applied = host.applyMutations([{ type: 'setAttribute', id: 1, name: 'src', value: hostile }]);
      expect(applied).toBe(0);
      expect(img.hasAttribute('src')).toBe(false);
    }

    // A blob: URL (guest-produced local asset — what previewResult uses) is accepted.
    const ok = host.applyMutations([{ type: 'setAttribute', id: 1, name: 'src', value: 'blob:https://x/abc' }]);
    expect(ok).toBe(1);
    expect(img.getAttribute('src')).toBe('blob:https://x/abc');

    // An INERT data:image (png) is passive-safe in the host DOM — §5 img-src data:
    // allowance — so it is accepted for a passive `src`.
    const dataOk = host.applyMutations([{ type: 'setAttribute', id: 1, name: 'src', value: 'data:image/png;base64,AAAA' }]);
    expect(dataOk).toBe(1);
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('drops a disallowed tag (e.g. script) outright', () => {
    const container = freshContainer();
    const host = new RemoteDomHost({ container });
    const applied = host.applyMutations([{ type: 'createElement', id: 9, tag: 'script' }]);
    expect(applied).toBe(0);
    expect(container.querySelector('script')).toBeNull();
  });
});

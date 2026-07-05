import { afterEach, expect, test } from 'vitest';
import { createLab } from '../main.ts';
import type { Lab } from '../main.ts';
import { installResizeConvertWorkflow } from './workflow.ts';

const T = 20000;
let lab: Lab | undefined;

afterEach(() => { lab?.dispose(); lab = undefined; });

async function fixturePng(width = 40, height = 20): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function readVfs(l: Lab, path: string): Promise<Uint8Array> {
  const h = await l.vfs.open(path, { read: true });
  try {
    const chunks: Uint8Array[] = [];
    let off = 0;
    for (;;) {
      const c = await l.vfs.read(h, off, 65536);
      if (!c || c.byteLength === 0) break;
      chunks.push(new Uint8Array(c));
      off += c.byteLength;
    }
    let total = 0; for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    return out;
  } finally {
    await Promise.resolve(l.vfs.close(h)).catch(() => {});
  }
}

async function seed(l: Lab, path: string, bytes: Uint8Array): Promise<void> {
  const h = await l.vfs.open(path, { write: true, create: true, truncate: true });
  try {
    await l.vfs.write(h, bytes, 0);
  } finally {
    await Promise.resolve(l.vfs.close(h)).catch(() => {});
  }
}

async function runWorkflow(
  l: Lab,
  width: string,
  format: string,
  inPath: string,
  outPath: string,
): Promise<number> {
  const { pid, stdout } = await l.kernel.spawn('resize-convert', {
    args: ['resize-convert', width, format, inPath, outPath],
    env: { PATH: '/usr/bin:/bin' },
    cwd: '/',
    capabilities: [
      { type: 'fs', paths: ['/'], operations: ['read', 'write', 'execute'] },
      { type: 'process', maxChildren: 16 },
    ],
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await l.kernel.wait(pid);
  if (stdout) await stdout;
  return code;
}

test('resize-convert workflow chains imgresize -> imgconvert; output is a resized WebP', async () => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/photo.png', await fixturePng(40, 20));
  await installResizeConvertWorkflow(lab.vfs);

  const code = await runWorkflow(lab, '16', 'webp', '/in/photo.png', '/out/photo.webp');
  expect(code).toBe(0);

  const out = await readVfs(lab, '/out/photo.webp');
  expect(out.byteLength).toBeGreaterThan(0);
  // WebP magic: "RIFF"...."WEBP"
  expect(new TextDecoder().decode(out.subarray(0, 4))).toBe('RIFF');
  expect(new TextDecoder().decode(out.subarray(8, 12))).toBe('WEBP');
  // Decode + confirm the resize preserved the 2:1 aspect ratio (40x20 -> 16x8),
  // never upscaling: width was reduced to the target.
  const bmp = await createImageBitmap(new Blob([out.slice()], { type: 'image/webp' }));
  expect(bmp.width).toBe(16);
  expect(bmp.height).toBe(8);
  bmp.close();
}, T);

// The OUT extension drives the output format (png/jpg/jpeg/webp supported); FORMAT ($2)
// is reserved and intentionally not consumed. Verify the extension-driven selection
// works for JPEG and PNG output, not just WebP.
test.each([
  ['jpeg', 'jpg', '/out/photo.jpg', 'image/jpeg', [0xff, 0xd8, 0xff]],
  ['png', 'png', '/out/photo2.png', 'image/png', [0x89, 0x50, 0x4e, 0x47]],
])('resize-convert emits %s per output extension (FORMAT arg reserved, unused)', async (
  _label,
  format,
  outPath,
  mime,
  magic,
) => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/photo.png', await fixturePng(40, 20));
  await installResizeConvertWorkflow(lab.vfs);

  const code = await runWorkflow(lab, '16', format, '/in/photo.png', outPath);
  expect(code).toBe(0);

  const out = await readVfs(lab, outPath);
  expect(out.byteLength).toBeGreaterThan(0);
  expect(Array.from(out.subarray(0, magic.length))).toEqual(magic);
  const bmp = await createImageBitmap(new Blob([out.slice()], { type: mime }));
  expect(bmp.width).toBe(16);
  expect(bmp.height).toBe(8);
  bmp.close();
}, T);

test('resize-convert never upscales: a target wider than the source is clamped to source width', async () => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/photo.png', await fixturePng(40, 20));
  await installResizeConvertWorkflow(lab.vfs);

  // Request 1024px on a 40px-wide source; imgresize never upscales -> stays 40x20.
  const code = await runWorkflow(lab, '1024', 'webp', '/in/photo.png', '/out/big.webp');
  expect(code).toBe(0);

  const out = await readVfs(lab, '/out/big.webp');
  expect(out.byteLength).toBeGreaterThan(0);
  const bmp = await createImageBitmap(new Blob([out.slice()], { type: 'image/webp' }));
  expect(bmp.width).toBe(40);
  expect(bmp.height).toBe(20);
  bmp.close();
}, T);

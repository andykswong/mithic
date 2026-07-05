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
  const chunks: Uint8Array[] = [];
  let off = 0;
  for (;;) {
    const c = await l.vfs.read(h, off, 65536);
    if (!c || c.byteLength === 0) break;
    chunks.push(new Uint8Array(c));
    off += c.byteLength;
  }
  await l.vfs.close(h);
  let total = 0; for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

async function seed(l: Lab, path: string, bytes: Uint8Array): Promise<void> {
  const h = await l.vfs.open(path, { write: true, create: true, truncate: true });
  await l.vfs.write(h, bytes, 0);
  await l.vfs.close(h);
}

test('resize-convert workflow chains imgresize -> imgconvert; output is a resized WebP', async () => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/photo.png', await fixturePng(40, 20));
  await installResizeConvertWorkflow(lab.vfs);

  const { pid, stdout } = await lab.kernel.spawn('resize-convert', {
    args: ['resize-convert', '16', 'webp', '/in/photo.png', '/out/photo.webp'],
    env: { PATH: '/usr/bin:/bin' },
    cwd: '/',
    capabilities: [
      { type: 'fs', paths: ['/'], operations: ['read', 'write', 'execute'] },
      { type: 'process', maxChildren: 16 },
    ],
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout;
  expect(code).toBe(0);

  const out = await readVfs(lab, '/out/photo.webp');
  expect(out.byteLength).toBeGreaterThan(0);
  // WebP magic: "RIFF"...."WEBP"
  expect(new TextDecoder().decode(out.subarray(0, 4))).toBe('RIFF');
  expect(new TextDecoder().decode(out.subarray(8, 12))).toBe('WEBP');
  // Decode + confirm width was reduced to the target (never upscales; 40 -> 16).
  const bmp = await createImageBitmap(new Blob([out.slice()], { type: 'image/webp' }));
  expect(bmp.width).toBe(16);
  bmp.close();
}, T);

import { expect, test, describe } from 'vitest';
import { imgresizeCommand } from './imgresize.ts';
import { imgconvertCommand } from './imgconvert.ts';
import { makeIO } from './_testio.ts';

/** Render a solid-colour image of the given size to a typed-array of `type`. */
async function makeImage(width: number, height: number, type: string): Promise<Uint8Array> {
  const cv = new OffscreenCanvas(width, height);
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, width, height);
  const blob = await cv.convertToBlob({ type });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Decode an image file's bytes to its intrinsic pixel dimensions. */
async function dimensions(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(new Blob([bytes.slice()]));
  const dims = { width: bmp.width, height: bmp.height };
  bmp.close();
  return dims;
}

const readBytes = async (fs: ReturnType<typeof makeIO>['fs'], path: string): Promise<Uint8Array> => {
  const h = await fs.open(path, { read: true });
  const data = await fs.read(h, 0, 1 << 24);
  await fs.close(h);
  return new Uint8Array(data);
};

describe('imgresize', () => {
  test('resizes to WIDTH, preserving aspect ratio', async () => {
    const png = await makeImage(200, 100, 'image/png');
    const h = makeIO({
      args: ['imgresize', '/in.png', '/out.webp'],
      env: { WIDTH: '64' },
      files: { '/in.png': png },
    });
    expect(await imgresizeCommand(h.io)).toBe(0);
    const out = await dimensions(await readBytes(h.fs, '/out.webp'));
    expect(out.width).toBe(64);
    expect(out.height).toBe(32);
  });

  test('defaults to 512 px wide when WIDTH is absent', async () => {
    const png = await makeImage(1024, 512, 'image/png');
    const h = makeIO({ args: ['imgresize', '/in.png', '/out.png'], files: { '/in.png': png } });
    expect(await imgresizeCommand(h.io)).toBe(0);
    const out = await dimensions(await readBytes(h.fs, '/out.png'));
    expect(out.width).toBe(512);
    expect(out.height).toBe(256);
  });

  test('never upscales beyond the source width', async () => {
    const png = await makeImage(40, 20, 'image/png');
    const h = makeIO({
      args: ['imgresize', '/in.png', '/out.png'],
      env: { WIDTH: '4096' },
      files: { '/in.png': png },
    });
    expect(await imgresizeCommand(h.io)).toBe(0);
    const out = await dimensions(await readBytes(h.fs, '/out.png'));
    expect(out.width).toBe(40);
    expect(out.height).toBe(20);
  });

  test('output type follows the output extension', async () => {
    const png = await makeImage(100, 100, 'image/png');
    const h = makeIO({
      args: ['imgresize', '/in.png', '/out.jpeg'],
      env: { WIDTH: '50' },
      files: { '/in.png': png },
    });
    expect(await imgresizeCommand(h.io)).toBe(0);
    const bytes = await readBytes(h.fs, '/out.jpeg');
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  test('resolves cwd-relative input/output paths', async () => {
    const png = await makeImage(80, 80, 'image/png');
    const h = makeIO({
      args: ['imgresize', 'in.png', 'out.png'],
      cwd: '/work',
      env: { WIDTH: '20' },
      files: { '/work/in.png': png },
    });
    expect(await imgresizeCommand(h.io)).toBe(0);
    const out = await dimensions(await readBytes(h.fs, '/work/out.png'));
    expect(out.width).toBe(20);
  });

  test('missing operands error with a non-zero exit', async () => {
    const h = makeIO({ args: ['imgresize', '/in.png'], files: { '/in.png': new Uint8Array() } });
    expect(await imgresizeCommand(h.io)).toBe(1);
    expect(h.err()).toContain('imgresize');
  });

  test('a missing input file errors', async () => {
    const h = makeIO({ args: ['imgresize', '/nope.png', '/out.png'], env: { WIDTH: '32' } });
    expect(await imgresizeCommand(h.io)).toBe(1);
    expect(h.err()).toContain('imgresize');
  });

  test('garbage (non-image) input errors', async () => {
    const h = makeIO({
      args: ['imgresize', '/in.png', '/out.png'],
      env: { WIDTH: '32' },
      files: { '/in.png': new Uint8Array([1, 2, 3, 4, 5]) },
    });
    expect(await imgresizeCommand(h.io)).toBe(1);
    expect(h.err()).toContain('imgresize');
  });

  test('an invalid WIDTH errors', async () => {
    const png = await makeImage(100, 100, 'image/png');
    const h = makeIO({
      args: ['imgresize', '/in.png', '/out.png'],
      env: { WIDTH: 'wide' },
      files: { '/in.png': png },
    });
    expect(await imgresizeCommand(h.io)).toBe(1);
    expect(h.err()).toContain('imgresize');
  });
});

describe('imgconvert', () => {
  test('converts PNG to WebP at the same dimensions', async () => {
    const png = await makeImage(120, 90, 'image/png');
    const h = makeIO({ args: ['imgconvert', '/in.png', '/out.webp'], files: { '/in.png': png } });
    expect(await imgconvertCommand(h.io)).toBe(0);
    const out = await dimensions(await readBytes(h.fs, '/out.webp'));
    expect(out.width).toBe(120);
    expect(out.height).toBe(90);
  });

  test('converts to JPEG (SOI marker) from the output extension', async () => {
    const png = await makeImage(64, 64, 'image/png');
    const h = makeIO({ args: ['imgconvert', '/in.png', '/out.jpg'], files: { '/in.png': png } });
    expect(await imgconvertCommand(h.io)).toBe(0);
    const bytes = await readBytes(h.fs, '/out.jpg');
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  test('resolves cwd-relative paths', async () => {
    const png = await makeImage(48, 48, 'image/png');
    const h = makeIO({
      args: ['imgconvert', 'in.png', 'out.webp'],
      cwd: '/work',
      files: { '/work/in.png': png },
    });
    expect(await imgconvertCommand(h.io)).toBe(0);
    const out = await dimensions(await readBytes(h.fs, '/work/out.webp'));
    expect(out.width).toBe(48);
  });

  test('missing operands error', async () => {
    const h = makeIO({ args: ['imgconvert', '/in.png'], files: { '/in.png': new Uint8Array() } });
    expect(await imgconvertCommand(h.io)).toBe(1);
    expect(h.err()).toContain('imgconvert');
  });

  test('an unknown output extension errors', async () => {
    const png = await makeImage(32, 32, 'image/png');
    const h = makeIO({ args: ['imgconvert', '/in.png', '/out.xyz'], files: { '/in.png': png } });
    expect(await imgconvertCommand(h.io)).toBe(1);
    expect(h.err()).toContain('imgconvert');
  });

  test('garbage input errors', async () => {
    const h = makeIO({
      args: ['imgconvert', '/in.png', '/out.webp'],
      files: { '/in.png': new Uint8Array([9, 9, 9]) },
    });
    expect(await imgconvertCommand(h.io)).toBe(1);
    expect(h.err()).toContain('imgconvert');
  });
});

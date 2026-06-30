/**
 * `imgresize` — resize an image to a target width via `OffscreenCanvas`.
 *
 *   WIDTH=64  imgresize IN OUT
 *
 * Decodes IN with `createImageBitmap`, draws it onto an `OffscreenCanvas`
 * scaled to `WIDTH` (default 512) preserving aspect ratio, and writes the
 * re-encoded bytes to OUT — all by VFS path-arg via the standard File System
 * Access surface (`readPath`/`writePath`). The output image type follows the
 * OUT extension (default WebP). Never upscales: a `WIDTH` larger than the
 * source width keeps the source dimensions.
 */
import { readPath, writePath } from '@mithic/guest-runtime';
import { defineCommand, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { pathContext } from '../path-context.ts';
import { bytesToBlob, mimeForPath } from './_image.ts';

const DEFAULT_WIDTH = 512;

const imgresizeCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const [, src, dst] = io.args;
  const err = io.stderr.getWriter();
  try {
    if (src === undefined || dst === undefined) {
      await writeLine(err, 'imgresize: usage: WIDTH=px imgresize IN OUT');
      return 1;
    }
    const type = mimeForPath(dst);
    if (type === undefined) {
      await writeLine(err, `imgresize: unsupported output format: ${dst}`);
      return 1;
    }

    let target = DEFAULT_WIDTH;
    if (io.env.WIDTH !== undefined) {
      target = Number(io.env.WIDTH);
      if (!Number.isFinite(target) || target <= 0) {
        await writeLine(err, `imgresize: invalid WIDTH: ${io.env.WIDTH}`);
        return 1;
      }
    }

    const g = pathContext(io);
    try {
      const srcBytes = await readPath(g, src);
      const bmp = await createImageBitmap(bytesToBlob(srcBytes));
      try {
        const width = Math.min(Math.round(target), bmp.width);
        const height = Math.max(1, Math.round((bmp.height * width) / bmp.width));
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          await writeLine(err, 'imgresize: no 2d canvas context');
          return 1;
        }
        ctx.drawImage(bmp, 0, 0, width, height);
        const out = await canvas.convertToBlob({ type });
        await writePath(g, dst, new Uint8Array(await out.arrayBuffer()));
      } finally {
        bmp.close();
      }
      return 0;
    } catch (e) {
      await writeLine(err, `imgresize: ${(e as Error).message}`);
      return 1;
    }
  } finally {
    await err.close().catch(() => {});
  }
};

export default defineCommand(imgresizeCommand);
export { imgresizeCommand };

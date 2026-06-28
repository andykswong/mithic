/**
 * `imgconvert` — re-encode an image to a different format via `OffscreenCanvas`.
 *
 *   imgconvert IN OUT
 *
 * Decodes IN with `createImageBitmap`, draws it onto an `OffscreenCanvas` at its
 * native dimensions, and writes the re-encoded bytes to OUT — all by VFS
 * path-arg via the standard File System Access surface (`readPath`/`writePath`).
 * The target format is taken from the OUT extension (`.png`/`.jpg`/`.jpeg`/
 * `.webp`); an unknown extension errors.
 */
import { createStorageManager, readPath, writePath } from '@mithic/guest-runtime';
import type { PathContext } from '@mithic/guest-runtime';
import { defineCommand, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { bytesToBlob, mimeForPath } from './_image.ts';

const imgconvertCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const [, src, dst] = io.args;
  const err = io.stderr.getWriter();
  try {
    if (src === undefined || dst === undefined) {
      await writeLine(err, 'imgconvert: usage: imgconvert IN OUT');
      return 1;
    }
    const type = mimeForPath(dst);
    if (type === undefined) {
      await writeLine(err, `imgconvert: unsupported output format: ${dst}`);
      return 1;
    }

    const g = pathContext(io);
    try {
      const srcBytes = await readPath(g, src);
      const bmp = await createImageBitmap(bytesToBlob(srcBytes));
      try {
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          await writeLine(err, 'imgconvert: no 2d canvas context');
          return 1;
        }
        ctx.drawImage(bmp, 0, 0);
        const out = await canvas.convertToBlob({ type });
        await writePath(g, dst, new Uint8Array(await out.arrayBuffer()));
      } finally {
        bmp.close();
      }
      return 0;
    } catch (e) {
      await writeLine(err, `imgconvert: ${(e as Error).message}`);
      return 1;
    }
  } finally {
    await err.close().catch(() => {});
  }
};

/** A {@link PathContext} (the surface `readPath`/`writePath` read) over the command IO. */
function pathContext(io: CommandIO): PathContext {
  return { cwd: io.cwd, fs: createStorageManager(io.syscall, io.cwd) };
}

export default defineCommand(imgconvertCommand);
export { imgconvertCommand };

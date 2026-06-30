/**
 * `strings` — print sequences of printable characters in a file.
 *
 * Forms:
 *   strings [-n N] [FILE]
 *     -n N   minimum run length (default 4)
 *
 * Scans the bytes for maximal runs of printable ASCII (0x20–0x7e); each run of
 * at least N bytes is printed on its own line. Reads stdin when FILE is `-` or
 * omitted.
 */
import { defineCommand, parseArgs, readAll, writeLine, exitWith } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const isPrintable = (b: number): boolean => b >= 0x20 && b <= 0x7e;

const stringsCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'strings';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['n'],
    alias: { bytes: 'n' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    let min = 4;
    if (flags.n !== undefined) {
      const n = Number(flags.n);
      if (!Number.isInteger(n) || n < 1) return await exitWith(err, 1, `${name}: invalid minimum string length`);
      min = n;
    }

    const src = positionals[0];
    let bytes: Uint8Array;
    if (src === undefined || src === '-') bytes = await readAll(io.stdin);
    else {
      try { bytes = await readFile(io, src); }
      catch { return await exitWith(err, 1, `${name}: '${src}': No such file or directory`); }
    }

    const decoder = new TextDecoder('ascii');
    let runStart = -1;
    const emit = async (start: number, end: number): Promise<void> => {
      if (end - start >= min) await writeLine(out, decoder.decode(bytes.subarray(start, end)));
    };
    for (let i = 0; i < bytes.byteLength; i++) {
      if (isPrintable(bytes[i])) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        await emit(runStart, i);
        runStart = -1;
      }
    }
    if (runStart >= 0) await emit(runStart, bytes.byteLength);
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(stringsCommand);
export { stringsCommand };

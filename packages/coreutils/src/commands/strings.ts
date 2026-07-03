/**
 * `strings` — print sequences of printable characters in a file.
 *
 * Matches the BSD/LLVM `strings` (the macOS reference), not GNU binutils:
 *   strings [-] [-a] [-o] [-t d|o|x] [-number] [-n number] [--] [FILE]...
 *     -a            scan the whole file (default here; the flag is accepted)
 *     -n N / -N     minimum run length (default 4); `-3` is shorthand for `-n 3`
 *     -t d|o|x      print each string's byte OFFSET (decimal/octal/hex) before it
 *     -o            print the offset in DECIMAL, right-justified in a 7-wide field
 *                   (BSD `-o` — NOT equivalent to `-t o`)
 *
 * Scans the bytes for maximal runs of printable ASCII (0x20–0x7e); each run of
 * at least N bytes is printed on its own line, optionally prefixed with its
 * starting byte offset. Reads stdin when FILE is `-` or omitted.
 */
import { defineCommand, parseArgs, readAll, writeLine, exitWith, optionError } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const isPrintable = (b: number): boolean => b >= 0x20 && b <= 0x7e;

/** Format the offset prefix for a run starting at `off`, per the chosen radix. */
function offsetPrefix(off: number, radix: 'd' | 'o' | 'x' | undefined, bsdO: boolean): string {
  if (bsdO) return String(off).padStart(7) + ' ';         // -o : %7d + space
  if (radix === undefined) return '';
  if (radix === 'x') return off.toString(16) + ' ';        // -t x : %x + space
  if (radix === 'o') return off.toString(8) + ' ';         // -t o : %o + space
  return off.toString(10) + ' ';                            // -t d : %d + space
}

const stringsCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'strings';
  // BSD `strings` accepts a bare `-N` (a leading-digit run) as the min length.
  // Rewrite such tokens to `-n N` so parseArgs handles them uniformly.
  const rawArgs = io.args.slice(1).map((a) => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : a));
  const parsed = parseArgs(rawArgs, {
    string: ['n', 't'],
    boolean: ['a', 'o'],
    alias: { bytes: 'n', radix: 't' },
    unknown: 'error',
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (parsed.unknown.length) return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    const { positionals, flags } = parsed;

    let min = 4;
    if (flags.n !== undefined) {
      const n = Number(flags.n);
      if (!Number.isInteger(n) || n < 1) return await exitWith(err, 1, `${name}: invalid minimum string length`);
      min = n;
    }
    let radix: 'd' | 'o' | 'x' | undefined;
    if (flags.t !== undefined) {
      const t = String(flags.t);
      if (t !== 'd' && t !== 'o' && t !== 'x') return await exitWith(err, 1, `${name}: invalid radix`);
      radix = t;
    }
    const bsdO = Boolean(flags.o);

    const sources = positionals.length > 0 ? positionals : ['-'];
    let code = 0;
    const decoder = new TextDecoder('ascii');
    for (const src of sources) {
      let bytes: Uint8Array;
      if (src === '-') bytes = await readAll(io.stdin);
      else {
        try { bytes = await readFile(io, src); }
        catch { await writeLine(err, `${name}: '${src}': No such file or directory`); code = 1; continue; }
      }
      let runStart = -1;
      const emit = async (start: number, end: number): Promise<void> => {
        if (end - start >= min) {
          await writeLine(out, offsetPrefix(start, radix, bsdO) + decoder.decode(bytes.subarray(start, end)));
        }
      };
      for (let i = 0; i < bytes.byteLength; i++) {
        if (isPrintable(bytes[i])) { if (runStart < 0) runStart = i; }
        else if (runStart >= 0) { await emit(runStart, i); runStart = -1; }
      }
      if (runStart >= 0) await emit(runStart, bytes.byteLength);
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(stringsCommand);
export { stringsCommand };

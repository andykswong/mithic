/**
 * `od` — dump file bytes in octal / hex / character form.
 *
 * Supported subset (matches GNU coreutils `od` output, NOT BSD/macOS od, which
 * spaces its columns differently):
 *   -A x|d|o|n   address radix: heX, Decimal, Octal (default), or None
 *   -t x1        hex bytes        (` %02x` per byte)
 *   -t o1        octal bytes      (` %03o` per byte)
 *   -t d1        signed-dec bytes (` %4d` per byte)
 *   -c           named ASCII characters (` %3s` per byte: \0 \a \b \t \n \v \f
 *                \r, printable chars, else 3-digit octal)
 * The default type is `-t o1` and the default address radix is octal.
 *
 * 16 bytes per line. A final address-only line marks end-of-input (GNU prints
 * the total byte count in the chosen radix). FILE may be `-`/omitted for stdin.
 *
 * NOT yet faithful (documented follow-ups): multi-byte type widths (`x2`,`o2`,
 * `d2`,…), the `-A o -t o2` GNU default 2-byte-word grouping, duplicate-line
 * `*` elision, and combining multiple `-t` specs on one dump. The single-byte
 * forms above match GNU exactly for the tested cases.
 */
import { defineCommand, parseArgs, readAll, writeString, exitWith } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

type AddrRadix = 'x' | 'd' | 'o' | 'n';
type DumpType = 'x1' | 'o1' | 'd1' | 'c';

const NAMED: Record<number, string> = {
  0x00: '\\0', 0x07: '\\a', 0x08: '\\b', 0x09: '\\t',
  0x0a: '\\n', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r',
};

/** Render the running byte offset in the chosen radix (GNU widths). */
function formatAddress(offset: number, radix: AddrRadix): string {
  if (radix === 'n') return '';
  if (radix === 'x') return offset.toString(16).padStart(6, '0');
  if (radix === 'd') return offset.toString(10).padStart(7, '0');
  return offset.toString(8).padStart(7, '0'); // octal
}

/** Render one byte as its ` <field>` cell for the chosen dump type. */
function formatByte(b: number, type: DumpType): string {
  if (type === 'x1') return ' ' + b.toString(16).padStart(2, '0');
  if (type === 'o1') return ' ' + b.toString(8).padStart(3, '0');
  if (type === 'd1') {
    const signed = b > 127 ? b - 256 : b;
    return ' ' + String(signed).padStart(3, ' ');
  }
  // -c
  let rep: string;
  if (b in NAMED) rep = NAMED[b];
  else if (b >= 0x20 && b <= 0x7e) rep = String.fromCharCode(b);
  else rep = b.toString(8).padStart(3, '0');
  return ' ' + rep.padStart(3, ' ');
}

const odCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'od';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['A', 't'],
    boolean: ['c'],
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    const radix = (flags.A !== undefined ? String(flags.A) : 'o') as AddrRadix;
    if (!['x', 'd', 'o', 'n'].includes(radix)) {
      return await exitWith(err, 1, `${name}: invalid output address radix '${flags.A}'`);
    }
    let type: DumpType = 'o1';
    if (flags.c) type = 'c';
    else if (flags.t !== undefined) {
      const t = String(flags.t);
      if (t !== 'x1' && t !== 'o1' && t !== 'd1') {
        return await exitWith(err, 1, `${name}: type '${t}' not supported (only x1/o1/d1/-c)`);
      }
      type = t;
    }

    const src = positionals[0];
    let bytes: Uint8Array;
    if (src === undefined || src === '-') bytes = await readAll(io.stdin);
    else {
      try { bytes = await readFile(io, src); }
      catch { return await exitWith(err, 1, `${name}: ${src}: No such file or directory`); }
    }

    let line = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      if (i % 16 === 0) {
        if (i > 0) { await writeString(out, line + '\n'); }
        line = formatAddress(i, radix);
      }
      line += formatByte(bytes[i], type);
    }
    if (bytes.byteLength > 0) await writeString(out, line + '\n');

    // Final address-only line (GNU prints the byte total in the radix). With
    // `-A n` GNU emits nothing for it.
    if (radix !== 'n') await writeString(out, formatAddress(bytes.byteLength, radix) + '\n');
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(odCommand);
export { odCommand, formatAddress, formatByte };

/**
 * `od` — dump file bytes in octal / hex / character form.
 *
 * Supported subset (matches GNU coreutils `od` output, NOT BSD/macOS od, which
 * spaces its columns differently):
 *   -A x|d|o|n   address radix: heX, Decimal, Octal (default), or None
 *   -t x1        hex bytes        (` %02x` per byte)
 *   -t o1        octal bytes      (` %03o` per byte)
 *   -t d1        signed-dec bytes (` %4d` per byte)
 *   -t x2        hex 2-byte words        (` %04x` per LE word)
 *   -t o2        octal 2-byte words      (` %06o` per LE word)
 *   -t d2        signed-dec 2-byte words (` %6d` per LE word)
 *   -c           named ASCII characters (` %3s` per byte: \0 \a \b \t \n \v \f
 *                \r, printable chars, else 3-digit octal)
 * The default type is `-t o1` and the default address radix is octal.
 *
 * Multi-byte (`2`-width) types read host little-endian words — GNU does the same
 * on a little-endian host (low byte first). An odd trailing byte is padded with a
 * zero high byte to form a final partial word, matching GNU.
 *
 * Multiple type specs combine GNU-style: each `-t TYPE` and `-c` is collected in
 * command-line order, and every 16-byte block prints one line PER type (first
 * type carries the address, continuation lines blank the address column to its
 * width). `*` duplicate-block elision compares the full multi-type block.
 *
 * 16 bytes per line. Identical consecutive 16-byte lines are elided GNU-style:
 * the first is printed, a bare `*` marks the run of duplicates, and output
 * resumes at the first differing line. A final address-only line marks
 * end-of-input (GNU prints the total byte count in the chosen radix). FILE may be
 * `-`/omitted for stdin.
 */
import { defineCommand, parseArgs, readAll, writeString, exitWith } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

type AddrRadix = 'x' | 'd' | 'o' | 'n';
type DumpType = 'x1' | 'o1' | 'd1' | 'x2' | 'o2' | 'd2' | 'c';

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

/** Render one byte as its ` <field>` cell for a single-byte dump type. */
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

/** Render one little-endian 2-byte word as its ` <field>` cell. */
function formatWord(w: number, type: DumpType): string {
  if (type === 'x2') return ' ' + w.toString(16).padStart(4, '0');
  if (type === 'o2') return ' ' + w.toString(8).padStart(6, '0');
  // d2: signed 16-bit, field width 6.
  const signed = w > 0x7fff ? w - 0x10000 : w;
  return ' ' + String(signed).padStart(6, ' ');
}

const WORD_TYPES = new Set<DumpType>(['x2', 'o2', 'd2']);

function isDumpType(t: string): t is DumpType {
  return t === 'x1' || t === 'o1' || t === 'd1' || t === 'x2' || t === 'o2' || t === 'd2' || t === 'c';
}

/** Format the byte-region (everything after the address) of ONE 16-byte line. */
function formatRegion(bytes: Uint8Array, start: number, end: number, type: DumpType): string {
  let region = '';
  if (WORD_TYPES.has(type)) {
    for (let i = start; i < end; i += 2) {
      const lo = bytes[i];
      const hi = i + 1 < end ? bytes[i + 1] : 0; // odd trailing byte → high-zero word
      region += formatWord((hi << 8) | lo, type);
    }
  } else {
    for (let i = start; i < end; i++) region += formatByte(bytes[i], type);
  }
  return region;
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
    // Collect type specs in COMMAND-LINE ORDER: each `-t TYPE` / `-tTYPE` and each
    // `-c`. GNU prints one line per type per block, in this order. (parseArgs keeps
    // only the LAST -t, so the ordered list is gathered directly from argv here.)
    const types: DumpType[] = [];
    const argv = io.args.slice(1);
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-c') { types.push('c'); continue; }
      if (a === '-t') { const t = argv[++i]; if (t !== undefined) { if (!isDumpType(t)) return await exitWith(err, 1, `${name}: type '${t}' not supported (only x1/o1/d1/x2/o2/d2/-c)`); types.push(t); } continue; }
      if (a.startsWith('-t') && a.length > 2) { const t = a.slice(2); if (!isDumpType(t)) return await exitWith(err, 1, `${name}: type '${t}' not supported (only x1/o1/d1/x2/o2/d2/-c)`); types.push(t); continue; }
    }
    if (types.length === 0) types.push('o1'); // default

    const src = positionals[0];
    let bytes: Uint8Array;
    if (src === undefined || src === '-') bytes = await readAll(io.stdin);
    else {
      try { bytes = await readFile(io, src); }
      catch { return await exitWith(err, 1, `${name}: ${src}: No such file or directory`); }
    }

    // Emit 16-byte blocks. For multiple types GNU prints one line per type per
    // block (types in command-line order); only the FIRST line carries the
    // address, continuations blank it to the address width. `*` duplicate-block
    // elision compares the FULL multi-type block (all type regions concatenated).
    const addrWidth = formatAddress(0, radix).length;
    const blankAddr = ' '.repeat(addrWidth);
    let prevBlock: string | undefined;
    let eliding = false;
    for (let i = 0; i < bytes.byteLength; i += 16) {
      const end = Math.min(i + 16, bytes.byteLength);
      const regions = types.map((t) => formatRegion(bytes, i, end, t));
      const block = regions.join(' '); // elision key over ALL type regions
      if (prevBlock !== undefined && block === prevBlock) {
        if (!eliding) { await writeString(out, '*\n'); eliding = true; }
        continue;
      }
      eliding = false;
      prevBlock = block;
      for (let k = 0; k < regions.length; k++) {
        const addr = k === 0 ? formatAddress(i, radix) : blankAddr;
        await writeString(out, addr + regions[k] + '\n');
      }
    }

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
export { odCommand, formatAddress, formatByte, formatWord };

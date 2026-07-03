/**
 * `od` — dump file bytes in octal / hex / decimal / char / float form.
 *
 * Matches GNU coreutils `od` output (NOT BSD/macOS od, which spaces columns
 * differently). Supported subset:
 *   -A x|d|o|n        address radix: heX, Decimal, Octal (default), None
 *   -t TYPE           one or more output type specs (see below); repeatable
 *   -c                named-C-escape single bytes (` %3s` per byte)
 *   -N BYTES          dump at most BYTES bytes
 *   -j BYTES          skip BYTES bytes of input before dumping
 *   -v                do not elide duplicate lines with `*`
 *   -w[BYTES]         bytes per output line (default 16; bare `-w` → 32)
 *   short type flags  -a(=t a) -b(=o1) -c -d(=u2) -f(=f4) -h(=x2) -i(=d4)
 *                     -l(=d8) -o(=o2) -s(=d2) -x(=x2)
 *
 * TYPE grammar (GNU): a letter [acdfouxX] with an optional size suffix:
 *   a          named characters (control-char abbreviations)
 *   c          C-escape characters
 *   d/o/u/x    signed-dec / octal / unsigned-dec / hex integers, size 1/2/4/8
 *   f          float, size 4 (single) or 8 (double)
 * A trailing count digit (e.g. `x1`, `d4`, `f8`) sets the byte width; without a
 * digit the width defaults to `sizeof(int)` = 4 for integers and 8 (double) for
 * floats — matching GNU on a 64-bit host.
 *
 * The default type (no `-t`/short flag) is `o2` (2-byte octal words) and the
 * default address radix is octal. Multi-byte integer/float types read host
 * little-endian words (GNU does the same on a little-endian host). An odd
 * trailing partial word is padded with high-zero bytes to a full word, matching
 * GNU.
 *
 * Multiple type specs combine GNU-style: each `-t TYPE` / short flag / `-c` is
 * collected in command-line order; every output line prints one physical line
 * PER type (first type carries the address, continuation lines blank the address
 * column to its width). `*` duplicate-line elision compares the full multi-type
 * line. A final address-only line marks end-of-input (`-A n` emits nothing for
 * it). FILE may be `-`/omitted for stdin.
 */
import { defineCommand, readAll, writeString, exitWith } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

type AddrRadix = 'x' | 'd' | 'o' | 'n';

interface TypeSpec {
  /** Base letter: a c d o u x f. */
  kind: 'a' | 'c' | 'd' | 'o' | 'u' | 'x' | 'f';
  /** Bytes per datum (1/2/4/8). For a/c always 1. */
  size: number;
}

const NAMED_C: Record<number, string> = {
  0x00: '\\0', 0x07: '\\a', 0x08: '\\b', 0x09: '\\t',
  0x0a: '\\n', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r',
};

// GNU `-t a` named characters for 0x00–0x20 and 0x7f (control abbreviations).
const NAMED_A: string[] = [
  'nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel',
  'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si',
  'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb',
  'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp',
];

/** Render the running byte offset in the chosen radix (GNU widths). */
function formatAddress(offset: number, radix: AddrRadix): string {
  if (radix === 'n') return '';
  if (radix === 'x') return offset.toString(16).padStart(6, '0');
  if (radix === 'd') return offset.toString(10).padStart(7, '0');
  return offset.toString(8).padStart(7, '0'); // octal
}

/** Cell width (INCLUDING the leading space) for an integer datum type. */
function intCellWidth(kind: string, size: number): number {
  // Leading space + field. Field widths from GNU od (see module test vectors).
  if (kind === 'x') return 1 + size * 2;                    // %0{2*size}x
  if (kind === 'o') return 1 + { 1: 3, 2: 6, 4: 11, 8: 22 }[size]!;  // %0{ceil}o
  if (kind === 'u') return 1 + { 1: 3, 2: 5, 4: 10, 8: 20 }[size]!;  // %{}u
  // d (signed): field one wider than u to leave room for a sign
  return 1 + { 1: 4, 2: 6, 4: 11, 8: 20 }[size]!;           // %{}d
}

/** Format one unsigned little-endian integer word of `size` bytes. */
function readWordLE(bytes: Uint8Array, start: number, end: number, size: number): bigint {
  let v = 0n;
  for (let k = size - 1; k >= 0; k--) {
    const idx = start + k;
    const b = idx < end ? bytes[idx] : 0; // odd trailing partial word → high-zero pad
    v = (v << 8n) | BigInt(b);
  }
  return v;
}

/** Render one integer datum ` <field>` cell. */
function formatInt(bytes: Uint8Array, start: number, end: number, spec: TypeSpec): string {
  const { kind, size } = spec;
  const width = intCellWidth(kind, size) - 1;
  const u = readWordLE(bytes, start, end, size);
  let text: string;
  if (kind === 'x') text = u.toString(16).padStart(size * 2, '0');
  else if (kind === 'o') text = u.toString(8).padStart({ 1: 3, 2: 6, 4: 11, 8: 22 }[size]!, '0');
  else if (kind === 'u') text = u.toString(10);
  else {
    // signed: interpret the top bit as sign
    const bits = BigInt(size) * 8n;
    const signBit = 1n << (bits - 1n);
    const s = u >= signBit ? u - (1n << bits) : u;
    text = s.toString(10);
  }
  return ' ' + text.padStart(width, ' ');
}

/**
 * Format a float in GNU od `%g` style: shortest round-trip mantissa, C-printf
 * scientific notation (2-digit-padded, signed exponent). `size` is 4 (single)
 * or 8 (double). Special values render as `nan` / `inf` / `-inf`.
 */
function formatFloat(bytes: Uint8Array, start: number, end: number, size: number): string {
  const width = size === 4 ? 15 : 24;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  for (let k = 0; k < size; k++) view.setUint8(k, start + k < end ? bytes[start + k] : 0);
  const v = size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
  let text: string;
  if (Number.isNaN(v)) text = 'nan';
  else if (v === Infinity) text = 'inf';
  else if (v === -Infinity) text = '-inf';
  else text = gStyle(shortest(v, size));
  return ' ' + text.padStart(width, ' ');
}

/** Shortest decimal string that round-trips through the given float width. */
function shortest(v: number, size: number): string {
  const roundtrips = (s: string): boolean => {
    const p = parseFloat(s);
    return size === 4 ? Math.fround(p) === Math.fround(v) : p === v;
  };
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  for (let p = 1; p <= 17; p++) {
    const s = v.toPrecision(p);
    if (roundtrips(s)) return s;
  }
  return v.toString();
}

/**
 * Reformat a JS numeric string into C-printf `%g` form: normalize the exponent
 * to a sign and ≥2 digits (`e-8` → `e-08`), and strip a leading `+` GNU never
 * prints on the mantissa. Fixed-notation strings pass through unchanged.
 */
function gStyle(s: string): string {
  const m = /^(-?)(\d+(?:\.\d+)?)e([+-])(\d+)$/i.exec(s);
  if (!m) {
    // toPrecision may have produced trailing-zero fixed forms like "781.03520";
    // strip trailing zeros after a decimal point (shortest already avoids this,
    // but toPrecision(p) can pad) — GNU prints the minimal mantissa.
    if (s.includes('.')) return s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  const [, sign, mant, esign, edig] = m;
  const mantTrim = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
  return `${sign}${mantTrim}e${esign}${edig.padStart(2, '0')}`;
}

/** Render one `-c` C-escape single byte cell (` %3s`). */
function formatCharC(b: number): string {
  let rep: string;
  if (b in NAMED_C) rep = NAMED_C[b];
  else if (b >= 0x20 && b <= 0x7e) rep = String.fromCharCode(b);
  else rep = b.toString(8).padStart(3, '0');
  return ' ' + rep.padStart(3, ' ');
}

/** Render one `-t a` named-character single byte cell (` %3s`). */
function formatCharA(b: number): string {
  let rep: string;
  if (b < NAMED_A.length) rep = NAMED_A[b];
  else if (b === 0x7f) rep = 'del';
  else if (b >= 0x21 && b <= 0x7e) rep = String.fromCharCode(b);
  else rep = (b & 0x7f).toString(); // high-bit chars fall back to low-7-bit name in GNU; rarely hit
  return ' ' + rep.padStart(3, ' ');
}

/** Bytes per datum for a type (1 for a/c). */
function datumSize(spec: TypeSpec): number {
  return spec.kind === 'a' || spec.kind === 'c' ? 1 : spec.size;
}

/** Natural cell width (INCLUDING leading space) of ONE datum of `spec`. */
function cellWidth(spec: TypeSpec): number {
  if (spec.kind === 'a' || spec.kind === 'c') return 4; // ` %3s`
  if (spec.kind === 'f') return spec.size === 4 ? 16 : 25;
  return intCellWidth(spec.kind, spec.size);
}

/** Format ONE datum of `spec` starting at `i` (bytes clamped by `end`). */
function formatDatum(bytes: Uint8Array, i: number, end: number, spec: TypeSpec): string {
  if (spec.kind === 'c') return formatCharC(bytes[i]);
  if (spec.kind === 'a') return formatCharA(bytes[i]);
  if (spec.kind === 'f') return formatFloat(bytes, i, end, spec.size);
  return formatInt(bytes, i, end, spec);
}

/**
 * Format the region of ONE spec over the byte group `[start,end)`. Datums are
 * emitted left-to-right (multi-byte types zero-pad a trailing partial datum),
 * then the whole group is left-padded to `groupWidth` so columns line up across
 * specs with different datum sizes (GNU alignment).
 */
function formatGroup(bytes: Uint8Array, start: number, end: number, spec: TypeSpec, groupWidth: number): string {
  const size = datumSize(spec);
  let region = '';
  for (let i = start; i < end; i += size) region += formatDatum(bytes, i, end, spec);
  return region.length >= groupWidth ? region : ' '.repeat(groupWidth - region.length) + region;
}

/** Parse one `-t` argument into one-or-more {@link TypeSpec} (GNU allows `x1x2`). */
function parseTypeArg(arg: string): TypeSpec[] | null {
  const specs: TypeSpec[] = [];
  let i = 0;
  while (i < arg.length) {
    const kind = arg[i++];
    if (kind === 'a' || kind === 'c') { specs.push({ kind, size: 1 }); continue; }
    if (kind === 'd' || kind === 'o' || kind === 'u' || kind === 'x' || kind === 'f') {
      // optional size: a digit run, or a C-size letter (C=1 S=2 I=4 L=8) / F/D/L for floats.
      let size: number;
      const c = arg[i];
      if (c !== undefined && c >= '0' && c <= '9') {
        let num = '';
        while (i < arg.length && arg[i] >= '0' && arg[i] <= '9') num += arg[i++];
        size = parseInt(num, 10);
      } else if (kind === 'f') {
        if (c === 'F') { size = 4; i++; } else if (c === 'D') { size = 8; i++; }
        else if (c === 'L') { size = 8; i++; } else size = 8; // default float = double
      } else {
        if (c === 'C') { size = 1; i++; } else if (c === 'S') { size = 2; i++; }
        else if (c === 'I') { size = 4; i++; } else if (c === 'L') { size = 8; i++; }
        else size = 4; // default int = sizeof(int)
      }
      if (kind === 'f') { if (size !== 4 && size !== 8) return null; }
      else if (size !== 1 && size !== 2 && size !== 4 && size !== 8) return null;
      specs.push({ kind, size });
      continue;
    }
    return null; // unrecognized type letter
  }
  return specs.length > 0 ? specs : null;
}

/** Map a short type flag (-b -d -f -h -i -l -o -s -x -a -c) to a TypeSpec. */
const SHORT_TYPE: Record<string, TypeSpec> = {
  a: { kind: 'a', size: 1 },
  b: { kind: 'o', size: 1 },
  c: { kind: 'c', size: 1 },
  d: { kind: 'u', size: 2 },
  f: { kind: 'f', size: 4 },
  h: { kind: 'x', size: 2 },
  i: { kind: 'd', size: 4 },
  l: { kind: 'd', size: 8 },
  o: { kind: 'o', size: 2 },
  s: { kind: 'd', size: 2 },
  x: { kind: 'x', size: 2 },
};

/** Parse a GNU byte-count argument (plain decimal; a leading 0 → octal, 0x → hex). */
function parseCount(s: string): number | null {
  if (!/^0[xX][0-9a-fA-F]+$|^0[0-7]*$|^[0-9]+$/.test(s)) return null;
  const n = /^0[xX]/.test(s) ? parseInt(s, 16) : /^0[0-7]/.test(s) ? parseInt(s, 8) : parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const odCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'od';
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    // Manual scan: type specs must preserve command-line ORDER (parseArgs keeps
    // only the last of each), and several short flags act as type selectors.
    const argv = io.args.slice(1);
    const specs: TypeSpec[] = [];
    const positionals: string[] = [];
    let radix: AddrRadix = 'o';
    let width = 16;
    let limitN: number | undefined;
    let skipJ = 0;
    let noElide = false;
    let sawWidthFlag = false;

    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { for (i++; i < argv.length; i++) positionals.push(argv[i]); break; }
      if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }

      // Long options.
      if (a.startsWith('--')) {
        const body = a.slice(2);
        const eq = body.indexOf('=');
        const key = eq >= 0 ? body.slice(0, eq) : body;
        const val = eq >= 0 ? body.slice(eq + 1) : undefined;
        const take = (): string | undefined => val ?? argv[++i];
        if (key === 'address-radix') {
          const v = take(); if (v === undefined || !'xdon'.includes(v) || v.length !== 1)
            return await exitWith(err, 1, `${name}: invalid output address radix '${v ?? ''}'; it must be one character from [doxn]`);
          radix = v as AddrRadix; continue;
        }
        if (key === 'format' || key === 'type') {
          const v = take(); if (v === undefined) return await exitWith(err, 1, `${name}: option '--${key}' requires an argument`);
          const parsed = parseTypeArg(v); if (!parsed) return await exitWith(err, 1, `${name}: invalid type string '${v}'`);
          specs.push(...parsed); continue;
        }
        if (key === 'read-bytes') { const v = take(); const n = v !== undefined ? parseCount(v) : null; if (n === null) return await exitWith(err, 1, `${name}: invalid -N argument '${v ?? ''}'`); limitN = n; continue; }
        if (key === 'skip-bytes') { const v = take(); const n = v !== undefined ? parseCount(v) : null; if (n === null) return await exitWith(err, 1, `${name}: invalid -j argument '${v ?? ''}'`); skipJ = n; continue; }
        if (key === 'output-duplicates') { noElide = true; continue; }
        if (key === 'width') { sawWidthFlag = true; if (val !== undefined) { const n = parseCount(val); if (n === null || n === 0) return await exitWith(err, 1, `${name}: invalid -w argument '${val}'`); width = n; } else width = 32; continue; }
        return await exitWith(err, 1, `${name}: unrecognized option '--${key}'\nTry '${name} --help' for more information.`);
      }

      // Short cluster.
      const cluster = a.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const ch = cluster[j];
        if (ch === 'A') {
          const rest = cluster.slice(j + 1);
          const v = rest.length > 0 ? rest : argv[++i];
          if (v === undefined || v.length !== 1 || !'xdon'.includes(v))
            return await exitWith(err, 1, `${name}: invalid output address radix '${v ?? ''}'; it must be one character from [doxn]`);
          radix = v as AddrRadix; break;
        }
        if (ch === 't') {
          const rest = cluster.slice(j + 1);
          const v = rest.length > 0 ? rest : argv[++i];
          if (v === undefined) return await exitWith(err, 1, `${name}: option requires an argument -- 't'\nTry '${name} --help' for more information.`);
          const parsed = parseTypeArg(v);
          if (!parsed) return await exitWith(err, 1, `${name}: invalid type string '${v}'`);
          specs.push(...parsed); break;
        }
        if (ch === 'N') { const rest = cluster.slice(j + 1); const v = rest.length > 0 ? rest : argv[++i]; const n = v !== undefined ? parseCount(v) : null; if (n === null) return await exitWith(err, 1, `${name}: invalid -N argument '${v ?? ''}'`); limitN = n; break; }
        if (ch === 'j') { const rest = cluster.slice(j + 1); const v = rest.length > 0 ? rest : argv[++i]; const n = v !== undefined ? parseCount(v) : null; if (n === null) return await exitWith(err, 1, `${name}: invalid -j argument '${v ?? ''}'`); skipJ = n; break; }
        if (ch === 'w') { sawWidthFlag = true; const rest = cluster.slice(j + 1); if (rest.length > 0) { const n = parseCount(rest); if (n === null || n === 0) return await exitWith(err, 1, `${name}: invalid -w argument '${rest}'`); width = n; break; } width = 32; continue; }
        if (ch === 'v') { noElide = true; continue; }
        if (ch in SHORT_TYPE) { specs.push({ ...SHORT_TYPE[ch] }); continue; }
        return await exitWith(err, 1, `${name}: invalid option -- '${ch}'\nTry '${name} --help' for more information.`);
      }
    }
    void sawWidthFlag;

    if (specs.length === 0) specs.push({ kind: 'o', size: 2 }); // default -t o2

    // Read the source, applying -j skip and -N limit.
    const src = positionals[0];
    let bytes: Uint8Array;
    if (src === undefined || src === '-') bytes = await readAll(io.stdin);
    else {
      try { bytes = await readFile(io, src); }
      catch { return await exitWith(err, 1, `${name}: ${src}: No such file or directory`); }
    }
    if (skipJ > 0) {
      if (skipJ > bytes.byteLength) return await exitWith(err, 1, `${name}: cannot skip past end of combined input`);
      bytes = bytes.subarray(skipJ);
    }
    if (limitN !== undefined) bytes = bytes.subarray(0, limitN);

    // Cross-type column alignment (GNU): bytes are laid out in groups of the
    // largest datum size `G`; every group is `groupWidth = round(G * density)`
    // chars wide, where `density = max(cellWidth_i / size_i)` — so each spec's
    // group (whatever datum size it uses) left-pads to the same column width.
    const G = specs.reduce((m, s) => Math.max(m, datumSize(s)), 1);
    const density = specs.reduce((m, s) => Math.max(m, cellWidth(s) / datumSize(s)), 0);
    const groupWidth = Math.round(G * density);
    const formatLine = (start: number, end: number, spec: TypeSpec): string => {
      let region = '';
      for (let g = start; g < end; g += G) region += formatGroup(bytes, g, Math.min(g + G, end), spec, groupWidth);
      return region;
    };

    const addrWidth = formatAddress(0, radix).length;
    const blankAddr = ' '.repeat(addrWidth);
    let prevLine: string | undefined;
    let eliding = false;
    for (let i = 0; i < bytes.byteLength; i += width) {
      const end = Math.min(i + width, bytes.byteLength);
      const regions = specs.map((s) => formatLine(i, end, s));
      const lineKey = regions.join(' '); // elision key over ALL type regions
      if (!noElide && prevLine !== undefined && lineKey === prevLine && end - i === width) {
        if (!eliding) { await writeString(out, '*\n'); eliding = true; }
        continue;
      }
      eliding = false;
      prevLine = lineKey;
      for (let k = 0; k < regions.length; k++) {
        const addr = k === 0 ? formatAddress(i + skipJ, radix) : blankAddr;
        await writeString(out, addr + regions[k] + '\n');
      }
    }

    if (radix !== 'n') await writeString(out, formatAddress(bytes.byteLength + skipJ, radix) + '\n');
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(odCommand);
export { odCommand, formatAddress };

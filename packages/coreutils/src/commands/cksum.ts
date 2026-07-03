/**
 * `cksum` — print a checksum and byte count of each file (GNU coreutils 9
 * interface: `-a/--algorithm` selects the digest).
 * `sum` — print BSD (default) or System V (`-s`) checksum + block count.
 *
 * The default `cksum` algorithm is the POSIX cksum CRC (polynomial 0x04C11DB7,
 * non-reflected, with the byte length fed into the CRC after the data) — this
 * matches GNU/BSD `cksum`, NOT the reflected zlib CRC-32. `-a crc32b` selects
 * the reflected zlib CRC-32. `-a bsd|sysv` reuse the `sum` algorithms; the hash
 * algorithms (`md5`, `sha1/224/256/384/512`) print in GNU's BSD-tag form
 * (`ALGO (name) = hex`) by default or `hex  name` with `--untagged`.
 *
 * Usage: cksum [-a ALGO] [--tag|--untagged] [FILE...]   (stdin if no FILE)
 *        sum  [-r|-s] [FILE...]
 */
import { defineCommand, parseArgs, readAll, writeLine, writeString, exitWith } from '../harness.ts';
import { readFile } from '../fs.ts';
import { md5hex } from './_md5.ts';
import { sha224hex } from './_sha224.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

// ── CRC-32 (POSIX cksum polynomial: 0xEDB88320 reflected) ───────────────────

function buildCrc32Table(): Uint32Array {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[i] = c;
  }
  return tbl;
}

const CRC32_TABLE = buildCrc32Table();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) crc = CRC32_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  // This is the reflected (zlib/Ethernet) CRC-32. NOTE: this is NOT what POSIX
  // `cksum` prints — see posixCksum below for the cksum-command algorithm.
  return (~crc) >>> 0;
}

// ── POSIX cksum CRC (polynomial 0x04C11DB7, non-reflected, length-appended) ──
// The cksum(1) utility uses a different CRC from zlib: MSB-first with the
// un-reflected polynomial, and the file's byte LENGTH is fed into the CRC after
// the data (low-order octet first), then the result is bit-inverted. This
// matches GNU/BSD `cksum` exactly (e.g. empty → 4294967295, "a\n" → 2418082923).

function buildPosixCrcTable(): Uint32Array {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1);
    tbl[i] = c >>> 0;
  }
  return tbl;
}

const POSIX_CRC_TABLE = buildPosixCrcTable();

/** Fold `data` into a running POSIX cksum CRC (no length/inversion yet). */
function posixCksumUpdate(crc: number, data: Uint8Array): number {
  for (const b of data) crc = ((crc << 8) ^ POSIX_CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

/** Finalize a running POSIX cksum CRC: feed the total byte length, then invert. */
function posixCksumFinal(crc: number, totalLen: number): number {
  for (let len = totalLen; len !== 0; len = Math.floor(len / 256)) {
    crc = ((crc << 8) ^ POSIX_CRC_TABLE[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0;
  }
  return (~crc) >>> 0;
}

export function posixCksum(data: Uint8Array): number {
  return posixCksumFinal(posixCksumUpdate(0, data), data.length);
}

// ── BSD sum (the `sum` default / `sum -r`) ───────────────────────────────────
// The BSD algorithm is a 16-bit rotate-add; GNU `sum` reports the block count in
// 1024-byte units (NOT 512) and zero-pads the checksum to 5 digits.

/** Fold `data` into a running BSD sum (16-bit rotate-add). */
function bsdSumUpdate(s: number, data: Uint8Array): number {
  for (const b of data) s = ((s >> 1) + ((s & 1) << 15) + b) & 0xffff;
  return s;
}

export function bsdSum(data: Uint8Array): { checksum: number; blocks: number } {
  return { checksum: bsdSumUpdate(0, data), blocks: Math.ceil(data.length / 1024) };
}

// ── System V sum (sum -s / --sysv) ───────────────────────────────────────────
// The SysV algorithm sums every byte, then folds the 32-bit total twice into a
// 16-bit result: r = (s & 0xffff) + (s >> 16); checksum = (r & 0xffff) + (r >> 16).
// GNU reports the block count in 512-byte units and formats `%d %d name`.

/** Finalize a running byte-total into the SysV 16-bit checksum. */
function sysvFinal(total: number): number {
  const r = (total & 0xffff) + (Math.floor(total / 0x10000) & 0xffff);
  return (r & 0xffff) + (r >> 16);
}

// ── incremental checksum over one source (stream, never buffer the input) ──────

/** Byte-fold algorithms usable in constant memory (no full-input buffering). */
type FoldMode = 'crc' | 'crc32b' | 'bsd' | 'sysv';

/** Fold `data` into a running reflected zlib CRC-32 (the `-a crc32b` digest). */
function crc32bUpdate(crc: number, data: Uint8Array): number {
  for (const b of data) crc = CRC32_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

interface ChecksumResult { value: number; length: number; blocks: number; }

/**
 * Compute a byte-fold checksum of one source by READING IT CHUNK-BY-CHUNK and
 * folding each chunk into the running state (constant memory). `path === '-'`
 * reads stdin; otherwise the VFS file. This is the OOM fix: `… | cksum` never
 * buffers its (possibly huge/infinite) input — only the running state is kept.
 */
async function checksumSource(io: CommandIO, path: string, mode: FoldMode): Promise<ChecksumResult> {
  let state = mode === 'crc32b' ? 0xffffffff : 0; // crc32b starts inverted
  let length = 0;
  const reader = path === '-' ? io.stdin.getReader() : null;
  let fd = -1;
  if (reader === null) {
    ({ fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number });
  }
  try {
    for (;;) {
      let chunk: Uint8Array | undefined;
      if (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        chunk = value;
      } else {
        chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
        if (!chunk || chunk.byteLength === 0) break;
      }
      if (!chunk || chunk.byteLength === 0) continue;
      length += chunk.byteLength;
      if (mode === 'crc') state = posixCksumUpdate(state, chunk);
      else if (mode === 'crc32b') state = crc32bUpdate(state, chunk);
      else if (mode === 'bsd') state = bsdSumUpdate(state, chunk);
      else for (const b of chunk) state += b; // sysv: plain byte total (folded at end)
    }
  } finally {
    if (reader) reader.releaseLock();
    else await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
  if (mode === 'crc') return { value: posixCksumFinal(state, length), length, blocks: 0 };
  if (mode === 'crc32b') return { value: (~state) >>> 0, length, blocks: 0 };
  if (mode === 'bsd') return { value: state, length, blocks: Math.ceil(length / 1024) };
  return { value: sysvFinal(state), length, blocks: Math.ceil(length / 512) };
}

// `sum`: BSD (default / -r) or System V (-s / --sysv). BSD zero-pads the 5-digit
// checksum and space-pads a 5-wide block count; SysV prints `%d %d name`.
const sumCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'sum';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['r', 's', 'sysv'],
    alias: { sysv: 's' },
  });
  const sysv = Boolean(flags.s); // -r (BSD) is the default and simply overrides nothing
  const mode: FoldMode = sysv ? 'sysv' : 'bsd';
  const sources = positionals.length > 0 ? positionals : ['-'];

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  try {
    for (const src of sources) {
      let r: ChecksumResult;
      try { r = await checksumSource(io, src, mode); }
      catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
      const label = src === '-' ? '' : ' ' + src;
      if (sysv) await writeLine(out, `${r.value} ${r.blocks}${label}`);
      else await writeLine(out, `${String(r.value).padStart(5, '0')} ${String(r.blocks).padStart(5)}${label}`);
    }
    return exitCode;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

// ── cksum (GNU 9 `-a`/`--algorithm` interface) ───────────────────────────────

/** Valid `-a` argument list (GNU order), for the diagnostic on an invalid one. */
const CKSUM_ALGOS = ['bsd', 'sysv', 'crc', 'crc32b', 'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha2', 'sha3', 'blake2b', 'sm3'];

/** Uppercase BSD-tag label for a hash algorithm. */
const TAG_LABEL: Record<string, string> = { md5: 'MD5', sha1: 'SHA1', sha224: 'SHA224', sha256: 'SHA256', sha384: 'SHA384', sha512: 'SHA512' };

/** Compute the hex digest of `bytes` for a hash algorithm (md5 or a SHA family). */
async function hashHex(algo: string, bytes: Uint8Array): Promise<string> {
  if (algo === 'md5') return md5hex(bytes);
  // Web Crypto has no SHA-224 (crypto.subtle.digest throws NotSupportedError),
  // so it is computed pure-TS (same fallback precedent as md5). SHA-1/256/384/512
  // use Web Crypto.
  if (algo === 'sha224') return sha224hex(bytes);
  const cryptoName: Record<string, string> = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
  const buf = await crypto.subtle.digest(cryptoName[algo], bytes as unknown as BufferSource);
  let hex = '';
  for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

const cksumCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'cksum';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['a', 'algorithm'],
    boolean: ['tag', 'untagged'],
    alias: { algorithm: 'a' },
  });
  const algo = (flags.a !== undefined ? String(flags.a) : 'crc');
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (!CKSUM_ALGOS.includes(algo)) {
      const list = CKSUM_ALGOS.map((a) => `  - ‘${a}’`).join('\n');
      return await exitWith(err, 1, `${name}: invalid argument ‘${algo}’ for ‘--algorithm’\nValid arguments are:\n${list}\nTry '${name} --help' for more information.`);
    }
    // Algorithms unavailable in-sandbox (no Web Crypto / pure-TS impl). Match
    // GNU's algorithm namespace but fail loudly rather than emit a wrong digest.
    // (sha224 IS supported via the pure-TS _sha224 module; sha2/sha3/blake2b/sm3
    // are the GNU "family selector" / unavailable digests.)
    if (algo === 'sha2' || algo === 'sha3' || algo === 'blake2b' || algo === 'sm3') {
      return await exitWith(err, 1, `${name}: --algorithm=${algo} is not supported in this build`);
    }

    const isHash = algo === 'md5' || algo.startsWith('sha');
    const untagged = Boolean(flags.untagged);
    const sources = positionals.length > 0 ? positionals : ['-'];
    let exitCode = 0;

    for (const src of sources) {
      const label = src === '-' ? '' : ' ' + src;
      if (algo === 'crc' || algo === 'crc32b') {
        let r: ChecksumResult;
        try { r = await checksumSource(io, src, algo); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
        await writeLine(out, `${r.value} ${r.length}${label}`);
        continue;
      }
      if (algo === 'bsd') {
        let r: ChecksumResult;
        try { r = await checksumSource(io, src, 'bsd'); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
        await writeLine(out, `${String(r.value).padStart(5, '0')} ${String(r.blocks).padStart(5)}${label}`);
        continue;
      }
      if (algo === 'sysv') {
        let r: ChecksumResult;
        try { r = await checksumSource(io, src, 'sysv'); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
        await writeLine(out, `${r.value} ${r.blocks}${label}`);
        continue;
      }
      // Hash algorithms: buffer the source and digest it.
      if (isHash) {
        let bytes: Uint8Array;
        try { bytes = src === '-' ? await readAll(io.stdin) : await readFile(io, src); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
        const hex = await hashHex(algo, bytes);
        const shown = src === '-' ? '-' : src;
        if (untagged) await writeString(out, `${hex}  ${shown}\n`);
        else await writeString(out, `${TAG_LABEL[algo]} (${shown}) = ${hex}\n`);
      }
    }
    return exitCode;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export { checksumSource };
export type { FoldMode, ChecksumResult };

// cksum default export
export default defineCommand(cksumCommand);
export { cksumCommand, sumCommand };

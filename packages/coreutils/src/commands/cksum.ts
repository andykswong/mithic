/**
 * `cksum` — print CRC32 checksum and byte count of each file.
 * `sum` — print BSD checksum (16-bit sum) and block count (512-byte blocks).
 *
 * cksum uses the POSIX cksum CRC (polynomial 0x04C11DB7, non-reflected, with the
 * byte length fed into the CRC after the data) — matching GNU/BSD `cksum` output,
 * NOT the reflected zlib CRC-32. sum uses the traditional BSD algorithm: sum of
 * all bytes mod 65536, plus number of 512-byte blocks.
 *
 * Usage: cksum [FILE...]    (or stdin if no files)
 *        sum [FILE...]
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
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

// ── BSD sum (sum -s, the default) ────────────────────────────────────────────

/** Fold `data` into a running BSD sum (16-bit rotate-add). */
function bsdSumUpdate(s: number, data: Uint8Array): number {
  for (const b of data) s = ((s >> 1) + ((s & 1) << 15) + b) & 0xffff;
  return s;
}

export function bsdSum(data: Uint8Array): { checksum: number; blocks: number } {
  return { checksum: bsdSumUpdate(0, data), blocks: Math.ceil(data.length / 512) };
}

// ── incremental checksum over one source (stream, never buffer the input) ──────

interface ChecksumResult { value: number; length: number; blocks: number; }

/**
 * Compute the checksum of one source by READING IT CHUNK-BY-CHUNK and folding
 * each chunk into the running CRC/sum (constant memory). `path === '-'` reads
 * stdin; otherwise the VFS file. This is the OOM fix: `… | cksum` never buffers
 * its (possibly huge/infinite) input — only the running 32-bit state is kept.
 */
async function checksumSource(io: CommandIO, path: string, isCksum: boolean): Promise<ChecksumResult> {
  let crc = 0;
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
      crc = isCksum ? posixCksumUpdate(crc, chunk) : bsdSumUpdate(crc, chunk);
    }
  } finally {
    if (reader) reader.releaseLock();
    else await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
  if (isCksum) return { value: posixCksumFinal(crc, length), length, blocks: 0 };
  return { value: crc, length, blocks: Math.ceil(length / 512) };
}

function makeCksumCommand(cmdName: string, isCksum: boolean): CommandFn {
  return async (io: CommandIO): Promise<number> => {
    const name = io.args[0] ?? cmdName;
    const { positionals } = parseArgs(io.args.slice(1), {});
    const sources = positionals.length > 0 ? positionals : ['-'];

    const out = io.stdout.getWriter();
    const err = io.stderr.getWriter();
    let exitCode = 0;
    try {
      for (const src of sources) {
        let r: ChecksumResult;
        try { r = await checksumSource(io, src, isCksum); }
        catch {
          await writeLine(err, `${name}: ${src}: No such file or directory`);
          exitCode = 1;
          continue;
        }
        const label = src === '-' ? '' : ' ' + src;
        if (isCksum) {
          await writeLine(out, `${r.value} ${r.length}${label}`);
        } else {
          await writeLine(out, `${String(r.value).padStart(5)} ${String(r.blocks).padStart(5)}${label}`);
        }
      }
      return exitCode;
    } finally {
      await out.close().catch(() => { /* already closed */ });
      await err.close().catch(() => { /* already closed */ });
    }
  };
}

const cksumCommand = makeCksumCommand('cksum', true);
const sumCommand = makeCksumCommand('sum', false);

// cksum default export
export default defineCommand(cksumCommand);
export { cksumCommand, sumCommand };

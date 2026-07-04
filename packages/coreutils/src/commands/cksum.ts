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
const TAG_LABEL: Record<string, string> = { md5: 'MD5', sha1: 'SHA1', sha224: 'SHA224', sha256: 'SHA256', sha384: 'SHA384', sha512: 'SHA512', sm3: 'SM3' };

// ── BLAKE2b (RFC 7693), pure-TS via BigInt 64-bit words ──────────────────────
// Web Crypto has no BLAKE2b, so it is computed here (same pure-TS precedent as
// md5/sha224). Default output is 512 bits; `--length=N` selects an N-bit digest.

const B2B_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const B2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];
const M64 = 0xffffffffffffffffn;
const rotr64 = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & M64;

/** Compute the BLAKE2b digest (`outBytes` long, default 64) of `input`. */
export function blake2b(input: Uint8Array, outBytes = 64): Uint8Array {
  const h = B2B_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outBytes); // no key, param block
  let t = 0n;

  const compress = (block: Uint8Array, counter: bigint, last: boolean): void => {
    const m: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      for (let k = 7; k >= 0; k--) w = (w << 8n) | BigInt(block[i * 8 + k]);
      m.push(w);
    }
    const v = [...h, ...B2B_IV];
    v[12] ^= counter & M64;
    v[13] ^= (counter >> 64n) & M64;
    if (last) v[14] ^= M64;
    const mix = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
      v[a] = (v[a] + v[b] + x) & M64; v[d] = rotr64(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & M64; v[b] = rotr64(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & M64; v[d] = rotr64(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & M64; v[b] = rotr64(v[b] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = B2B_SIGMA[r];
      mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
      mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
      mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
      mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
      mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
      mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
      mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
      mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  };

  let off = 0;
  // All blocks except the final full-or-partial one are compressed as non-last.
  while (input.length - off > 128) {
    t += 128n;
    compress(input.subarray(off, off + 128), t, false);
    off += 128;
  }
  const finalBlock = new Uint8Array(128);
  finalBlock.set(input.subarray(off));
  t += BigInt(input.length - off);
  compress(finalBlock, t, true);

  const out = new Uint8Array(outBytes);
  for (let i = 0; i < outBytes; i++) out[i] = Number((h[i >> 3] >> BigInt((i & 7) * 8)) & 0xffn);
  return out;
}

// ── SM3 (GB/T 32905-2016), pure-TS 32-bit words ──────────────────────────────

const SM3_IV = new Uint32Array([
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
]);
const rotl32 = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;

/** Compute the 32-byte SM3 digest of `input`. */
export function sm3(input: Uint8Array): Uint8Array {
  const msgLen = input.length;
  const paddedLen = ((msgLen + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(input);
  buf[msgLen] = 0x80;
  const bitLen = msgLen * 8;
  for (let i = 0; i < 8; i++) buf[paddedLen - 1 - i] = (Math.floor(bitLen / 2 ** (8 * i)) & 0xff) >>> 0;

  const v = new Uint32Array(SM3_IV);
  const w = new Uint32Array(68);
  const w1 = new Uint32Array(64);
  const ff = (x: number, y: number, z: number, j: number): number =>
    j < 16 ? (x ^ y ^ z) : (((x & y) | (x & z) | (y & z)) >>> 0);
  const gg = (x: number, y: number, z: number, j: number): number =>
    j < 16 ? (x ^ y ^ z) : (((x & y) | (~x & z)) >>> 0);
  const p0 = (x: number): number => (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0;
  const p1 = (x: number): number => (x ^ rotl32(x, 15) ^ rotl32(x, 23)) >>> 0;

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) >>> 0;
    }
    for (let i = 16; i < 68; i++) {
      w[i] = (p1((w[i - 16] ^ w[i - 9] ^ rotl32(w[i - 3], 15)) >>> 0) ^ rotl32(w[i - 13], 7) ^ w[i - 6]) >>> 0;
    }
    for (let i = 0; i < 64; i++) w1[i] = (w[i] ^ w[i + 4]) >>> 0;

    let a = v[0], b = v[1], c = v[2], d = v[3], e = v[4], f = v[5], g = v[6], hh = v[7];
    for (let j = 0; j < 64; j++) {
      const tj = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = rotl32((rotl32(a, 12) + e + rotl32(tj, j % 32)) >>> 0, 7);
      const ss2 = (ss1 ^ rotl32(a, 12)) >>> 0;
      const tt1 = (ff(a, b, c, j) + d + ss2 + w1[j]) >>> 0;
      const tt2 = (gg(e, f, g, j) + hh + ss1 + w[j]) >>> 0;
      d = c; c = rotl32(b, 9); b = a; a = tt1;
      hh = g; g = rotl32(f, 19); f = e; e = p0(tt2);
    }
    v[0] = (v[0] ^ a) >>> 0; v[1] = (v[1] ^ b) >>> 0; v[2] = (v[2] ^ c) >>> 0; v[3] = (v[3] ^ d) >>> 0;
    v[4] = (v[4] ^ e) >>> 0; v[5] = (v[5] ^ f) >>> 0; v[6] = (v[6] ^ g) >>> 0; v[7] = (v[7] ^ hh) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (v[i] >>> 24) & 0xff; out[i * 4 + 1] = (v[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (v[i] >>> 8) & 0xff; out[i * 4 + 3] = v[i] & 0xff;
  }
  return out;
}

/** Lowercase hex of a byte array. */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Compute the hex digest of `bytes` for a hash algorithm (md5 or a SHA family). */
async function hashHex(algo: string, bytes: Uint8Array, blake2bBits = 512): Promise<string> {
  if (algo === 'md5') return md5hex(bytes);
  if (algo === 'blake2b') return toHex(blake2b(bytes, blake2bBits / 8));
  if (algo === 'sm3') return toHex(sm3(bytes));
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
    string: ['a', 'algorithm', 'length'],
    boolean: ['tag', 'untagged', 'z', 'zero'],
    alias: { algorithm: 'a', zero: 'z' },
  });
  const algo = (flags.a !== undefined ? String(flags.a) : 'crc');
  const term = flags.z ? '\x00' : '\n';
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (!CKSUM_ALGOS.includes(algo)) {
      const list = CKSUM_ALGOS.map((a) => `  - ‘${a}’`).join('\n');
      return await exitWith(err, 1, `${name}: invalid argument ‘${algo}’ for ‘--algorithm’\nValid arguments are:\n${list}\nTry '${name} --help' for more information.`);
    }
    // `sha2`/`sha3` are GNU "family selector" names that require `--length` to
    // pick a concrete digest; without a full multi-length SHA-2/3 impl they fail
    // loudly (matching GNU's exit 1 for a bare selector). blake2b and sm3 ARE
    // implemented pure-TS below.
    if (algo === 'sha2' || algo === 'sha3') {
      return await exitWith(err, 1, `${name}: --algorithm=${algo} is not supported in this build`);
    }

    // GNU only accepts `--length` for blake2b (and the sha2/sha3 selectors,
    // which this build rejects above); any other algorithm is an error.
    if (flags.length !== undefined && algo !== 'blake2b') {
      return await exitWith(err, 1, `${name}: --length is only supported with --algorithm blake2b, sha2, or sha3`);
    }

    // `--length` selects the BLAKE2b digest bit-length (multiple of 8, ≤ 512).
    let blake2bBits = 512;
    if (algo === 'blake2b' && typeof flags.length === 'string') {
      // xstrtol parity: skip a leading whitespace run and honor an optional
      // leading '+' before the digits; still reject trailing/non-numeric garbage.
      if (!/^\s*\+?\d+$/.test(flags.length)) {
        return await exitWith(err, 1, `${name}: invalid length: ‘${flags.length}’`);
      }
      const n = Number(flags.length.replace(/^\s*\+?/, ''));
      if (n > 512) {
        return await exitWith(err, 1, `${name}: invalid length: ‘${flags.length}’\n${name}: maximum digest length for ‘BLAKE2b’ is 512 bits`);
      }
      if (n % 8 !== 0) {
        return await exitWith(err, 1, `${name}: invalid length: ‘${flags.length}’\n${name}: length is not a multiple of 8`);
      }
      if (n !== 0) blake2bBits = n;
    }

    const isHash = algo === 'md5' || algo.startsWith('sha') || algo === 'blake2b' || algo === 'sm3';
    const untagged = Boolean(flags.untagged);
    const sources = positionals.length > 0 ? positionals : ['-'];
    let exitCode = 0;

    for (const src of sources) {
      const label = src === '-' ? '' : ' ' + src;
      if (algo === 'crc' || algo === 'crc32b') {
        let r: ChecksumResult;
        try { r = await checksumSource(io, src, algo); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
        await writeString(out, `${r.value} ${r.length}${label}${term}`);
        continue;
      }
      if (algo === 'bsd') {
        let r: ChecksumResult;
        try { r = await checksumSource(io, src, 'bsd'); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
        await writeString(out, `${String(r.value).padStart(5, '0')} ${String(r.blocks).padStart(5)}${label}${term}`);
        continue;
      }
      if (algo === 'sysv') {
        let r: ChecksumResult;
        try { r = await checksumSource(io, src, 'sysv'); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
        await writeString(out, `${r.value} ${r.blocks}${label}${term}`);
        continue;
      }
      // Hash algorithms: buffer the source and digest it.
      if (isHash) {
        let bytes: Uint8Array;
        try { bytes = src === '-' ? await readAll(io.stdin) : await readFile(io, src); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); exitCode = 1; continue; }
        const hex = await hashHex(algo, bytes, blake2bBits);
        const shown = src === '-' ? '-' : src;
        const tag = algo === 'blake2b' ? (blake2bBits === 512 ? 'BLAKE2b' : `BLAKE2b-${blake2bBits}`) : TAG_LABEL[algo];
        if (untagged) await writeString(out, `${hex}  ${shown}${term}`);
        else await writeString(out, `${tag} (${shown}) = ${hex}${term}`);
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

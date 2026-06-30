/**
 * Pure-TypeScript MD5 (RFC 1321), used by `md5sum`.
 *
 * Web Crypto exposes no MD5 (it is cryptographically broken), so the digest is
 * computed here with no dependencies and no WebAssembly. The algorithm is the
 * standard four-round RFC 1321 construction with the canonical `K` and shift
 * (`s`) tables and a little-endian length append; it is verified against the
 * RFC 1321 appendix A.5 test vectors in `_md5.test.ts`.
 *
 * All arithmetic is done modulo 2^32 with `>>> 0` to stay in the unsigned
 * 32-bit domain.
 */

// Per-round left-rotate amounts (RFC 1321 §3.4).
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(2^32 * abs(sin(i + 1))) for i = 0..63 (RFC 1321 §3.4).
const K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  return k;
})();

const rotl = (x: number, c: number): number => ((x << c) | (x >>> (32 - c))) >>> 0;

/** Compute the 16-byte MD5 digest of `input`. */
export function md5(input: Uint8Array): Uint8Array {
  const msgLen = input.length;
  // Padding: append 0x80, then zeros, until length ≡ 56 (mod 64); then the
  // original bit length as a 64-bit little-endian integer.
  const paddedLen = ((msgLen + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(input);
  buf[msgLen] = 0x80;
  // 64-bit little-endian bit length (only the low 53 bits are representable).
  const bitLen = msgLen * 8;
  for (let i = 0; i < 8; i++) {
    buf[paddedLen - 8 + i] = (Math.floor(bitLen / 2 ** (8 * i)) & 0xff) >>> 0;
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      m[i] = (buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24)) >>> 0;
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }

      f = (f + a + K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, S[i])) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let w = 0; w < 4; w++) {
    out[w * 4] = words[w] & 0xff;
    out[w * 4 + 1] = (words[w] >>> 8) & 0xff;
    out[w * 4 + 2] = (words[w] >>> 16) & 0xff;
    out[w * 4 + 3] = (words[w] >>> 24) & 0xff;
  }
  return out;
}

/** Lowercase hex of the MD5 digest of `input`. */
export function md5hex(input: Uint8Array): string {
  const digest = md5(input);
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}

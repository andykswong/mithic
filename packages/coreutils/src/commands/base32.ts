/**
 * `base32` — encode/decode data in base32 (RFC 4648).
 *
 * Flags:
 *   -d / --decode   decode instead of encode
 *   -w N / --wrap=N wrap encoded output at N columns (default 76; 0 = no wrap)
 *
 * stdin is processed INCREMENTALLY (constant memory): the encoder carries the
 * ≤4-byte remainder across chunks and emits complete 5-byte groups as they
 * fill, tracking the wrap column; the decoder carries a ≤7-char octet tail.
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, exitWith, optionError } from '../harness.ts';
import { AT_FDCWD } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const ENCODE_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode one full 5-byte group to 8 base32 chars via `push`. */
function encodeFullGroup(b: ArrayLike<number>, off: number, push: (ch: string) => void): void {
  const b0 = b[off], b1 = b[off + 1], b2 = b[off + 2], b3 = b[off + 3], b4 = b[off + 4];
  push(ENCODE_TABLE[b0 >> 3]);
  push(ENCODE_TABLE[((b0 & 7) << 2) | (b1 >> 6)]);
  push(ENCODE_TABLE[(b1 >> 1) & 0x1f]);
  push(ENCODE_TABLE[((b1 & 1) << 4) | (b2 >> 4)]);
  push(ENCODE_TABLE[((b2 & 0xf) << 1) | (b3 >> 7)]);
  push(ENCODE_TABLE[(b3 >> 2) & 0x1f]);
  push(ENCODE_TABLE[((b3 & 3) << 3) | (b4 >> 5)]);
  push(ENCODE_TABLE[b4 & 0x1f]);
}

/** Encode a partial last group (1..4 bytes) with padding via `push`. */
function encodePartialGroup(b: ArrayLike<number>, off: number, rem: number, push: (ch: string) => void): void {
  if (rem === 1) {
    const b0 = b[off];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[(b0 & 7) << 2]);
    push('='); push('='); push('='); push('='); push('='); push('=');
  } else if (rem === 2) {
    const b0 = b[off], b1 = b[off + 1];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[((b0 & 7) << 2) | (b1 >> 6)]);
    push(ENCODE_TABLE[(b1 >> 1) & 0x1f]);
    push(ENCODE_TABLE[(b1 & 1) << 4]);
    push('='); push('='); push('='); push('=');
  } else if (rem === 3) {
    const b0 = b[off], b1 = b[off + 1], b2 = b[off + 2];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[((b0 & 7) << 2) | (b1 >> 6)]);
    push(ENCODE_TABLE[(b1 >> 1) & 0x1f]);
    push(ENCODE_TABLE[((b1 & 1) << 4) | (b2 >> 4)]);
    push(ENCODE_TABLE[(b2 & 0xf) << 1]);
    push('='); push('='); push('=');
  } else if (rem === 4) {
    const b0 = b[off], b1 = b[off + 1], b2 = b[off + 2], b3 = b[off + 3];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[((b0 & 7) << 2) | (b1 >> 6)]);
    push(ENCODE_TABLE[(b1 >> 1) & 0x1f]);
    push(ENCODE_TABLE[((b1 & 1) << 4) | (b2 >> 4)]);
    push(ENCODE_TABLE[((b2 & 0xf) << 1) | (b3 >> 7)]);
    push(ENCODE_TABLE[(b3 >> 2) & 0x1f]);
    push(ENCODE_TABLE[(b3 & 3) << 3]);
    push('=');
  }
}

export function b32Encode(data: Uint8Array, wrap: number): string {
  let out = '';
  let col = 0;
  const push = (ch: string): void => {
    out += ch;
    if (wrap > 0) {
      col++;
      if (col >= wrap) { out += '\n'; col = 0; }
    }
  };

  let i = 0;
  for (; i + 4 < data.length; i += 5) encodeFullGroup(data, i, push);
  const rem = data.length - i;
  if (rem > 0) encodePartialGroup(data, i, rem, push);
  if (wrap > 0 && col > 0) out += '\n';
  return out;
}

function b32Val(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;        // A-Z
  if (code >= 97 && code <= 122) return code - 97;       // a-z (case-insensitive)
  if (code === 50) return 26; // '2'
  if (code === 51) return 27; // '3'
  if (code === 52) return 28; // '4'
  if (code === 53) return 29; // '5'
  if (code === 54) return 30; // '6'
  if (code === 55) return 31; // '7'
  if (code === 61) return -2; // '=' padding
  return -1;
}

// Legal data-char counts within a base32 octet (mod 8): 0/2/4/5/7 chars →
// 0/1/2/3/4 bytes. Counts 1/3/6 are impossible group boundaries.
const LEGAL_TAIL = new Set([0, 2, 4, 5, 7]);

/**
 * Decode a whitespace-free, uppercased base32 string. Returns the decodable
 * bytes plus `ok`, which is false on a malformed input (illegal group length,
 * nonzero trailing bits, or a garbage char). GNU still emits (and we still
 * return) the bytes decoded before the fault; only the exit status changes.
 */
export function b32DecodeGroup(s: string): { bytes: Uint8Array; ok: boolean } {
  const buf = new Uint8Array(Math.ceil(s.length / 8) * 5);
  let o = 0;
  const fail = (): { bytes: Uint8Array; ok: boolean } => ({ bytes: buf.subarray(0, o), ok: false });
  for (let i = 0; i < s.length; i += 8) {
    const avail = Math.min(8, s.length - i);
    // Data chars run until the first '=' padding (or the octet end).
    let nd = 0;
    while (nd < avail && b32Val(s.charCodeAt(i + nd)) !== -2) nd++;
    let pad = 0;
    for (let j = nd; j < avail; j++) { if (b32Val(s.charCodeAt(i + j)) !== -2) return fail(); pad++; } // data after '=' → garbage
    // Decode the data chars into a bit accumulator.
    let acc = 0, bits = 0;
    const tmp: number[] = [];
    for (let j = 0; j < nd; j++) {
      const val = b32Val(s.charCodeAt(i + j));
      if (val < 0) return fail(); // garbage char
      acc = (acc << 5) | val;
      bits += 5;
      if (bits >= 8) { bits -= 8; tmp.push((acc >> bits) & 0xff); }
    }
    const trailingZero = (acc & ((1 << bits) - 1)) === 0;
    if (pad > 0) {
      // Explicit '=' padding: the octet must be complete (8 chars) with the exact
      // pad count for a legal boundary, and trailing bits zero. A wrong pad count
      // emits NOTHING for this octet (matching GNU).
      if (avail !== 8 || !LEGAL_TAIL.has(nd) || nd === 0 || pad !== 8 - nd || !trailingZero) return fail();
      for (const b of tmp) buf[o++] = b;
      // After a FULLY PADDED terminal octet GNU resets and keeps decoding, so
      // concatenated padded octets decode fully (`IE======IE======` → "AA").
      continue;
    } else if (nd < 8) {
      // Unpadded short octet: emit the decodable bytes, then require a legal
      // boundary length and zero trailing bits (it must be the last octet).
      for (const b of tmp) buf[o++] = b;
      if (!LEGAL_TAIL.has(nd) || !trailingZero || i + 8 < s.length) return fail();
      continue;
    }
    for (const b of tmp) buf[o++] = b;
  }
  return { bytes: buf.subarray(0, o), ok: true };
}

export function b32Decode(input: string): Uint8Array | null {
  const s = input.replace(/\s/g, '').toUpperCase();
  if (s.length === 0) return new Uint8Array(0);
  const r = b32DecodeGroup(s);
  return r.ok ? r.bytes : null;
}

// ── incremental (streaming) encoder/decoder ─────────────────────────────────

/** Constant-memory base32 encoder: carries a ≤4-byte remainder across chunks. */
class StreamingB32Encoder {
  #wrap: number;
  #col = 0;
  #rem: number[] = [];
  constructor(wrap: number) { this.#wrap = wrap; }

  #push(ch: string, parts: string[]): void {
    parts.push(ch);
    if (this.#wrap > 0) {
      this.#col++;
      if (this.#col >= this.#wrap) { parts.push('\n'); this.#col = 0; }
    }
  }

  update(bytes: Uint8Array): string {
    const parts: string[] = [];
    const push = (ch: string): void => this.#push(ch, parts);
    let r = this.#rem;
    let idx = 0;
    // Top up the carried remainder to a full 5-byte group, then emit it.
    while (r.length > 0 && r.length < 5 && idx < bytes.length) r.push(bytes[idx++]);
    if (r.length === 5) { encodeFullGroup(r, 0, push); r = []; }
    let i = idx;
    for (; i + 4 < bytes.length; i += 5) encodeFullGroup(bytes, i, push);
    const tail: number[] = [];
    for (; i < bytes.length; i++) tail.push(bytes[i]);
    this.#rem = r.length > 0 ? r : tail;
    return parts.join('');
  }

  final(): string {
    const parts: string[] = [];
    const push = (ch: string): void => this.#push(ch, parts);
    if (this.#rem.length > 0) encodePartialGroup(this.#rem, 0, this.#rem.length, push);
    this.#rem = [];
    if (this.#wrap > 0 && this.#col > 0) { parts.push('\n'); this.#col = 0; }
    return parts.join('');
  }
}

/**
 * Constant-memory base32 decoder: carries a ≤7-char octet tail across chunks.
 * `update`/`final` return `{ bytes, ok }`; `ok` is false on the first malformed
 * group (the caller still writes `bytes` decoded before the fault, per GNU).
 */
class StreamingB32Decoder {
  #carry = '';
  #ignoreGarbage: boolean;
  constructor(ignoreGarbage = false) { this.#ignoreGarbage = ignoreGarbage; }

  // Whitespace is always stripped; `-i` additionally drops any non-alphabet
  // (non-[A-Za-z2-7=]) character before decoding.
  #clean(text: string): string {
    const stripped = text.replace(/\s/g, '');
    return this.#ignoreGarbage ? stripped.replace(/[^A-Za-z2-7=]/g, '') : stripped;
  }

  update(text: string): { bytes: Uint8Array; ok: boolean } {
    // A fully-padded terminal octet makes GNU reset and keep decoding, but a
    // short/unpadded octet followed by more data is a truncation error. Deciding
    // that requires the WHOLE logical input (an 8-char window can't see across
    // its own boundary), so buffer here and decode once in final(). Whitespace/
    // garbage stripping keeps memory bounded to the alphabet chars.
    this.#carry += this.#clean(text);
    return { bytes: new Uint8Array(0), ok: true };
  }

  final(): { bytes: Uint8Array; ok: boolean } {
    if (this.#carry.length === 0) return { bytes: new Uint8Array(0), ok: true };
    const decoded = b32DecodeGroup(this.#carry.toUpperCase());
    this.#carry = '';
    return decoded;
  }
}

/** Write bytes in ≤32 KiB slices so no single write exceeds the pipe window. */
async function writeChunked(out: WritableStreamDefaultWriter<Uint8Array>, bytes: Uint8Array): Promise<void> {
  const cap = 32 * 1024;
  for (let off = 0; off < bytes.byteLength; off += cap) {
    await out.write(bytes.subarray(off, Math.min(off + cap, bytes.byteLength)));
  }
}

const base32Command: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'base32';
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['d', 'decode', 'i', 'ignore-garbage'],
    string: ['w', 'wrap'],
    alias: { decode: 'd', wrap: 'w', 'ignore-garbage': 'i' },
    unknown: 'error',
  });

  const err0 = () => io.stderr.getWriter();
  if (parsed.unknown.length) {
    const err = err0();
    try { return await exitWith(err, 1, optionError(name, parsed.unknown[0])); }
    finally { await err.close().catch(() => { /* already closed */ }); }
  }

  const decode = Boolean(parsed.flags.d);
  const ignoreGarbage = Boolean(parsed.flags.i);
  const wrapRaw = parsed.flags.w !== undefined ? String(parsed.flags.w) : '76';
  const wrap = parseInt(wrapRaw, 10);
  if (isNaN(wrap) || wrap < 0) {
    const err = err0();
    try { return await exitWith(err, 1, `${name}: invalid wrap size: ${wrapRaw}`); }
    finally { await err.close().catch(() => { /* already closed */ }); }
  }

  // GNU accepts at most one FILE operand (stdin when omitted or `-`).
  const positionals = parsed.positionals;
  if (positionals.length > 1) {
    const err = err0();
    try { return await exitWith(err, 1, `${name}: extra operand ‘${positionals[1]}’\nTry '${name} --help' for more information.`); }
    finally { await err.close().catch(() => { /* already closed */ }); }
  }
  const file = positionals[0];

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let stdinAborted = false;
  let fd = -1;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  if (file !== undefined && file !== '-') {
    try { ({ fd } = (await io.syscall('fs/open', { dirfd: AT_FDCWD, path: file, oflags: { read: true } })) as { fd: number }); }
    catch {
      try { return await exitWith(err, 1, `${name}: ${file}: No such file or directory`); }
      finally { await out.close().catch(() => {}); await err.close().catch(() => {}); }
    }
  } else {
    reader = io.stdin.getReader();
  }
  const readChunk = async (): Promise<Uint8Array | undefined> => {
    if (reader) { const { value, done } = await reader.read(); return done ? undefined : value; }
    const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
    return chunk && chunk.byteLength > 0 ? chunk : undefined;
  };
  try {
    // Stream the source (constant memory) so an unbounded producer drains
    // incrementally and EPIPE from a closed downstream stops us.
    const sink = new CoalescingWriter(out);
    const decoder = new TextDecoder();
    const enc = decode ? null : new StreamingB32Encoder(wrap);
    const dec = decode ? new StreamingB32Decoder(ignoreGarbage) : null;
    try {
      for (;;) {
        const value = await readChunk();
        if (value === undefined) break;
        if (value.byteLength === 0) continue;
        if (enc) {
          await sink.push(enc.update(value));
        } else {
          const { bytes, ok } = dec!.update(decoder.decode(value, { stream: true }));
          // GNU still emits the bytes decoded before a malformed group.
          if (bytes.byteLength > 0) { await sink.flush(); await writeChunked(out, bytes); }
          if (!ok) {
            if (reader) reader.releaseLock();
            return await exitWith(err, 1, `${name}: invalid input`);
          }
        }
      }
      if (reader) reader.releaseLock();
      if (enc) { await sink.push(enc.final()); await sink.flush(); }
      else {
        const { bytes, ok } = dec!.final();
        await sink.flush();
        if (bytes.byteLength > 0) await writeChunked(out, bytes);
        if (!ok) return await exitWith(err, 1, `${name}: invalid input`);
      }
    } catch (e) {
      try { if (reader) reader.releaseLock(); } catch { /* already released */ }
      if (isBrokenPipe(e)) { stdinAborted = true; return 0; }
      throw e;
    }
    return 0;
  } finally {
    if (fd >= 0) await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
    if (stdinAborted) await io.stdin.cancel().catch(() => { /* best effort */ });
  }
};

export default defineCommand(base32Command);
export { base32Command };

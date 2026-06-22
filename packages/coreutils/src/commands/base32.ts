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
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, exitWith } from '../harness.ts';
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

export function b32Decode(input: string): Uint8Array | null {
  const s = input.replace(/\s/g, '').toUpperCase();
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 8 !== 0) return null;

  const maxOut = (s.length / 8) * 5;
  const buf = new Uint8Array(maxOut);
  let o = 0;

  for (let i = 0; i < s.length; i += 8) {
    const v = [];
    for (let j = 0; j < 8; j++) {
      const val = b32Val(s.charCodeAt(i + j));
      if (val < -2) return null; // invalid char
      v.push(val);
    }
    // v[k] = -2 means padding
    const pad = v.filter(x => x === -2).length;
    const vs = v.map(x => x < 0 ? 0 : x);
    buf[o++] = (vs[0] << 3) | (vs[1] >> 2);
    if (pad < 6) buf[o++] = ((vs[1] & 3) << 6) | (vs[2] << 1) | (vs[3] >> 4);
    if (pad < 4) buf[o++] = ((vs[3] & 0xf) << 4) | (vs[4] >> 1);
    if (pad < 3) buf[o++] = ((vs[4] & 1) << 7) | (vs[5] << 2) | (vs[6] >> 3);
    if (pad < 1) buf[o++] = ((vs[6] & 7) << 5) | vs[7];
  }
  return buf.subarray(0, o);
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

/** Constant-memory base32 decoder: carries a ≤7-char octet tail across chunks. */
class StreamingB32Decoder {
  #carry = '';

  update(text: string): Uint8Array | null {
    const s = this.#carry + text.replace(/\s/g, '');
    const whole = s.length - (s.length % 8);
    this.#carry = s.slice(whole);
    if (whole === 0) return new Uint8Array(0);
    return b32Decode(s.slice(0, whole));
  }

  final(): Uint8Array | null {
    if (this.#carry.length === 0) return new Uint8Array(0);
    const decoded = b32Decode(this.#carry);
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
  const { flags } = parseArgs(io.args.slice(1), {
    boolean: ['d', 'decode'],
    string: ['w', 'wrap'],
    alias: { decode: 'd', wrap: 'w' },
  });

  const decode = Boolean(flags.d);
  const wrapRaw = flags.w !== undefined ? String(flags.w) : '76';
  const wrap = parseInt(wrapRaw, 10);
  if (isNaN(wrap) || wrap < 0) {
    const err = io.stderr.getWriter();
    try { return await exitWith(err, 1, `${name}: invalid wrap size: ${wrapRaw}`); }
    finally { await err.close().catch(() => { /* already closed */ }); }
  }

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let stdinAborted = false;
  try {
    // Stream stdin (constant memory) so an unbounded producer drains incrementally
    // and EPIPE from a closed downstream stops us.
    const sink = new CoalescingWriter(out);
    const reader = io.stdin.getReader();
    const decoder = new TextDecoder();
    const enc = decode ? null : new StreamingB32Encoder(wrap);
    const dec = decode ? new StreamingB32Decoder() : null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (enc) {
          await sink.push(enc.update(value));
        } else {
          const piece = dec!.update(decoder.decode(value, { stream: true }));
          if (piece === null) {
            reader.releaseLock();
            return await exitWith(err, 1, `${name}: invalid input`);
          }
          if (piece.byteLength > 0) { await sink.flush(); await writeChunked(out, piece); }
        }
      }
      reader.releaseLock();
      if (enc) { await sink.push(enc.final()); await sink.flush(); }
      else {
        const piece = dec!.final();
        if (piece === null) return await exitWith(err, 1, `${name}: invalid input`);
        await sink.flush();
        if (piece.byteLength > 0) await writeChunked(out, piece);
      }
    } catch (e) {
      try { reader.releaseLock(); } catch { /* already released */ }
      if (isBrokenPipe(e)) { stdinAborted = true; return 0; }
      throw e;
    }
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
    if (stdinAborted) await io.stdin.cancel().catch(() => { /* best effort */ });
  }
};

export default defineCommand(base32Command);
export { base32Command };

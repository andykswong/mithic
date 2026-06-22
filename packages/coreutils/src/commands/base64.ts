/**
 * `base64` — encode/decode data in base64.
 *
 * Flags:
 *   -d / --decode   decode instead of encode
 *   -w N / --wrap=N wrap encoded output at N columns (default 76; 0 = no wrap)
 *
 * stdin is processed INCREMENTALLY (constant memory): the encoder carries the
 * ≤2-byte remainder across chunks and emits complete 3-byte groups as they
 * fill, tracking the wrap column; the decoder carries a ≤3-char quartet tail.
 * So `cat /dev/zero | base64 | head -c N` streams and terminates on EPIPE
 * instead of buffering the whole (infinite) input and OOM-ing the host.
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const ENCODE_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64Encode(data: Uint8Array, wrap: number): string {
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
  for (; i + 2 < data.length; i += 3) {
    const b0 = data[i], b1 = data[i + 1], b2 = data[i + 2];
    push(ENCODE_TABLE[b0 >> 2]);
    push(ENCODE_TABLE[((b0 & 3) << 4) | (b1 >> 4)]);
    push(ENCODE_TABLE[((b1 & 0xf) << 2) | (b2 >> 6)]);
    push(ENCODE_TABLE[b2 & 0x3f]);
  }
  const rem = data.length - i;
  if (rem === 1) {
    const b0 = data[i];
    push(ENCODE_TABLE[b0 >> 2]);
    push(ENCODE_TABLE[(b0 & 3) << 4]);
    push('='); push('=');
  } else if (rem === 2) {
    const b0 = data[i], b1 = data[i + 1];
    push(ENCODE_TABLE[b0 >> 2]);
    push(ENCODE_TABLE[((b0 & 3) << 4) | (b1 >> 4)]);
    push(ENCODE_TABLE[(b1 & 0xf) << 2]);
    push('=');
  }
  if (wrap > 0 && col > 0) out += '\n';
  return out;
}

export function b64Decode(input: string): Uint8Array | null {
  // Strip all whitespace
  const s = input.replace(/\s/g, '');
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 4 !== 0) return null;

  const buf = new Uint8Array((s.length / 4) * 3);
  let len = buf.length;
  let o = 0;

  for (let i = 0; i < s.length; i += 4) {
    const v0 = b64Val(s.charCodeAt(i));
    const v1 = b64Val(s.charCodeAt(i + 1));
    const v2 = b64Val(s.charCodeAt(i + 2));
    const v3 = b64Val(s.charCodeAt(i + 3));
    if (v0 < 0 || v1 < 0) return null;

    buf[o++] = (v0 << 2) | (v1 >> 4);
    if (v2 >= 0) buf[o++] = ((v1 & 0xf) << 4) | (v2 >> 2);
    else len--;
    if (v3 >= 0) buf[o++] = ((v2 & 3) << 6) | v3;
    else len--;
  }
  return buf.subarray(0, len);
}

function b64Val(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  if (code === 61) return -2; // padding '='
  return -1;
}

// ── incremental (streaming) encoder ─────────────────────────────────────────

/**
 * A constant-memory base64 encoder driven chunk-by-chunk. `update(bytes)` emits
 * the base64 for all complete 3-byte groups available (carrying a ≤2-byte tail),
 * `final()` emits the padded last group. Wrap column is tracked across calls.
 */
class StreamingB64Encoder {
  #wrap: number;
  #col = 0;
  #rem: number[] = []; // ≤2 carried input bytes
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
    // Combine the carried remainder with the new bytes (≤2 + chunk).
    let r = this.#rem;
    let idx = 0;
    // Drain carried bytes first by pulling from the new chunk until a full triple.
    while (r.length > 0 && r.length < 3 && idx < bytes.length) { r.push(bytes[idx++]); }
    if (r.length === 3) {
      const [b0, b1, b2] = r;
      this.#push(ENCODE_TABLE[b0 >> 2], parts);
      this.#push(ENCODE_TABLE[((b0 & 3) << 4) | (b1 >> 4)], parts);
      this.#push(ENCODE_TABLE[((b1 & 0xf) << 2) | (b2 >> 6)], parts);
      this.#push(ENCODE_TABLE[b2 & 0x3f], parts);
      r = [];
    }
    // Process whole triples from the rest of the chunk.
    let i = idx;
    for (; i + 2 < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      this.#push(ENCODE_TABLE[b0 >> 2], parts);
      this.#push(ENCODE_TABLE[((b0 & 3) << 4) | (b1 >> 4)], parts);
      this.#push(ENCODE_TABLE[((b1 & 0xf) << 2) | (b2 >> 6)], parts);
      this.#push(ENCODE_TABLE[b2 & 0x3f], parts);
    }
    // Whatever is left (0..2 bytes) becomes the new remainder.
    const tail: number[] = [];
    for (; i < bytes.length; i++) tail.push(bytes[i]);
    this.#rem = r.length > 0 ? r : tail;
    return parts.join('');
  }

  final(): string {
    const parts: string[] = [];
    const r = this.#rem;
    if (r.length === 1) {
      const b0 = r[0];
      this.#push(ENCODE_TABLE[b0 >> 2], parts);
      this.#push(ENCODE_TABLE[(b0 & 3) << 4], parts);
      this.#push('=', parts); this.#push('=', parts);
    } else if (r.length === 2) {
      const b0 = r[0], b1 = r[1];
      this.#push(ENCODE_TABLE[b0 >> 2], parts);
      this.#push(ENCODE_TABLE[((b0 & 3) << 4) | (b1 >> 4)], parts);
      this.#push(ENCODE_TABLE[(b1 & 0xf) << 2], parts);
      this.#push('=', parts);
    }
    this.#rem = [];
    if (this.#wrap > 0 && this.#col > 0) { parts.push('\n'); this.#col = 0; }
    return parts.join('');
  }
}

/**
 * A constant-memory base64 decoder driven chunk-by-chunk. Each `update()` strips
 * whitespace, carries a ≤3-char quartet tail across calls, and decodes complete
 * quartets to bytes; `final()` validates the leftover and returns its bytes.
 * Returns `null` from `update`/`final` on the first invalid quartet.
 */
class StreamingB64Decoder {
  #carry = '';

  update(text: string): Uint8Array | null {
    const s = this.#carry + text.replace(/\s/g, '');
    const whole = s.length - (s.length % 4);
    this.#carry = s.slice(whole);
    if (whole === 0) return new Uint8Array(0);
    const decoded = b64Decode(s.slice(0, whole));
    return decoded;
  }

  final(): Uint8Array | null {
    if (this.#carry.length === 0) return new Uint8Array(0);
    const decoded = b64Decode(this.#carry);
    this.#carry = '';
    return decoded;
  }
}

/** Write bytes in ≤64 KiB slices so no single write exceeds the pipe window. */
async function writeChunked(out: WritableStreamDefaultWriter<Uint8Array>, bytes: Uint8Array): Promise<void> {
  const cap = 32 * 1024;
  for (let off = 0; off < bytes.byteLength; off += cap) {
    await out.write(bytes.subarray(off, Math.min(off + cap, bytes.byteLength)));
  }
}

function makeBase64Command(name: string): CommandFn {
  return async (io: CommandIO): Promise<number> => {
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
      // Stream stdin so an unbounded producer drains incrementally (constant
      // memory) and EPIPE from a closed downstream stops us.
      const sink = new CoalescingWriter(out);
      const reader = io.stdin.getReader();
      const decoder = new TextDecoder();
      const enc = decode ? null : new StreamingB64Encoder(wrap);
      const dec = decode ? new StreamingB64Decoder() : null;
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
}

const base64Command = makeBase64Command('base64');

export default defineCommand(base64Command);
export { base64Command };

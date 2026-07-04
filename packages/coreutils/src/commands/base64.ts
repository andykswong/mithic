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
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, exitWith, optionError } from '../harness.ts';
import { AT_FDCWD } from '../fs.ts';
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

/**
 * Decode a whitespace-free base64 string. Returns the bytes decodable from valid
 * leading groups plus `ok`, which is false when the input is malformed. GNU
 * behavior: a group of 4 data chars decodes 3 bytes; a terminal group may be
 * either UNPADDED (2/3 data chars — legal only as the last group) or explicitly
 * PADDED (2 data + `==`, or 3 data + `=`), in both cases the final data char's
 * unused low bits must be zero. A lone tail char, a wrong padding count, a
 * garbage char, or any data after a terminal group is an error — but GNU still
 * emits (and we still return) the bytes decoded before the fault.
 */
export function b64DecodeGroup(s: string): { bytes: Uint8Array; ok: boolean } {
  const buf = new Uint8Array(Math.ceil(s.length / 4) * 3);
  let o = 0;
  const fail = (): { bytes: Uint8Array; ok: boolean } => ({ bytes: buf.subarray(0, o), ok: false });
  for (let i = 0; i < s.length; i += 4) {
    const n = Math.min(4, s.length - i); // chars available in this quartet
    // b64Val: ≥0 data value, -2 padding '=', -1 garbage. `pad` counts explicit
    // '=' chars; `nd` is the count of leading real-data chars.
    const raw = [b64Val(s.charCodeAt(i)),
      n > 1 ? b64Val(s.charCodeAt(i + 1)) : -3,
      n > 2 ? b64Val(s.charCodeAt(i + 2)) : -3,
      n > 3 ? b64Val(s.charCodeAt(i + 3)) : -3];
    if (raw.some((v) => v === -1)) return fail(); // garbage char
    const pad = raw.filter((v) => v === -2).length;
    const nd = raw.filter((v) => v >= 0).length;
    const [v0, v1, v2, v3] = raw;
    if (v0 < 0 || v1 < 0) return fail(); // need ≥2 data chars
    // Data must be contiguous then padding (no data after a '=').
    if (nd === 2 && v2 >= 0) return fail();
    if (nd === 3 && v3 >= 0) return fail();
    buf[o++] = (v0 << 2) | (v1 >> 4);
    if (nd >= 3) buf[o++] = ((v1 & 0xf) << 4) | (v2 >> 2);
    if (nd === 4) { buf[o++] = ((v2 & 3) << 6) | v3; continue; }
    // Terminal group (2 or 3 data chars): trailing bits must be zero, and — when
    // '=' padding is present — the group must be a full 4 chars.
    if (nd === 3 && (v2 & 3)) return fail();
    if (nd === 2 && (v1 & 0xf)) return fail();
    if (pad > 0 && pad !== 4 - nd) return fail(); // wrong pad count
    // After a FULLY PADDED terminal quantum GNU resets and keeps decoding, so
    // concatenated streams (`YQ==YQ==`) decode fully. A short UNPADDED tail
    // followed by more data is a genuine truncation → fail.
    if (i + 4 < s.length) { if (pad === 4 - nd) continue; return fail(); }
  }
  return { bytes: buf.subarray(0, o), ok: true };
}

export function b64Decode(input: string): Uint8Array | null {
  const s = input.replace(/\s/g, '');
  if (s.length === 0) return new Uint8Array(0);
  const r = b64DecodeGroup(s);
  return r.ok ? r.bytes : null;
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
 * quartets to bytes; `final()` validates the leftover (unpadded tails, trailing
 * bits). Both return `{ bytes, ok }`; `ok` is false on the first malformed group
 * (the caller still writes `bytes` decoded before the fault, matching GNU).
 */
class StreamingB64Decoder {
  #carry = '';
  #ignoreGarbage: boolean;
  constructor(ignoreGarbage = false) { this.#ignoreGarbage = ignoreGarbage; }

  // Whitespace is always stripped; `-i` additionally drops any non-alphabet
  // (non-[A-Za-z0-9+/=]) character before decoding.
  #clean(text: string): string {
    const stripped = text.replace(/\s/g, '');
    return this.#ignoreGarbage ? stripped.replace(/[^A-Za-z0-9+/=]/g, '') : stripped;
  }

  update(text: string): { bytes: Uint8Array; ok: boolean } {
    const s = this.#carry + this.#clean(text);
    const whole = s.length - (s.length % 4);
    this.#carry = s.slice(whole);
    if (whole === 0) return { bytes: new Uint8Array(0), ok: true };
    return b64DecodeGroup(s.slice(0, whole));
  }

  final(): { bytes: Uint8Array; ok: boolean } {
    if (this.#carry.length === 0) return { bytes: new Uint8Array(0), ok: true };
    const decoded = b64DecodeGroup(this.#carry);
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
    // Open the FILE operand (if any) as a byte source; a missing file exits 1.
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
      // Stream the source so an unbounded producer drains incrementally (constant
      // memory) and EPIPE from a closed downstream stops us.
      const sink = new CoalescingWriter(out);
      const decoder = new TextDecoder();
      const enc = decode ? null : new StreamingB64Encoder(wrap);
      const dec = decode ? new StreamingB64Decoder(ignoreGarbage) : null;
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
}

const base64Command = makeBase64Command('base64');

export default defineCommand(base64Command);
export { base64Command };

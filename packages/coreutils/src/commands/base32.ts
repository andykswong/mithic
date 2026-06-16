/**
 * `base32` — encode/decode data in base32 (RFC 4648).
 *
 * Flags:
 *   -d / --decode   decode instead of encode
 *   -w N / --wrap=N wrap encoded output at N columns (default 76; 0 = no wrap)
 */
import { defineCommand, parseArgs, readAll, writeString, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const ENCODE_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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
  // Process 5-byte groups (produces 8 base32 chars)
  for (; i + 4 < data.length; i += 5) {
    const b0 = data[i], b1 = data[i+1], b2 = data[i+2], b3 = data[i+3], b4 = data[i+4];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[((b0 & 7) << 2) | (b1 >> 6)]);
    push(ENCODE_TABLE[(b1 >> 1) & 0x1f]);
    push(ENCODE_TABLE[((b1 & 1) << 4) | (b2 >> 4)]);
    push(ENCODE_TABLE[((b2 & 0xf) << 1) | (b3 >> 7)]);
    push(ENCODE_TABLE[(b3 >> 2) & 0x1f]);
    push(ENCODE_TABLE[((b3 & 3) << 3) | (b4 >> 5)]);
    push(ENCODE_TABLE[b4 & 0x1f]);
  }
  const rem = data.length - i;
  if (rem === 1) {
    const b0 = data[i];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[(b0 & 7) << 2]);
    push('='); push('='); push('='); push('='); push('='); push('=');
  } else if (rem === 2) {
    const b0 = data[i], b1 = data[i+1];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[((b0 & 7) << 2) | (b1 >> 6)]);
    push(ENCODE_TABLE[(b1 >> 1) & 0x1f]);
    push(ENCODE_TABLE[(b1 & 1) << 4]);
    push('='); push('='); push('='); push('=');
  } else if (rem === 3) {
    const b0 = data[i], b1 = data[i+1], b2 = data[i+2];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[((b0 & 7) << 2) | (b1 >> 6)]);
    push(ENCODE_TABLE[(b1 >> 1) & 0x1f]);
    push(ENCODE_TABLE[((b1 & 1) << 4) | (b2 >> 4)]);
    push(ENCODE_TABLE[(b2 & 0xf) << 1]);
    push('='); push('='); push('=');
  } else if (rem === 4) {
    const b0 = data[i], b1 = data[i+1], b2 = data[i+2], b3 = data[i+3];
    push(ENCODE_TABLE[b0 >> 3]);
    push(ENCODE_TABLE[((b0 & 7) << 2) | (b1 >> 6)]);
    push(ENCODE_TABLE[(b1 >> 1) & 0x1f]);
    push(ENCODE_TABLE[((b1 & 1) << 4) | (b2 >> 4)]);
    push(ENCODE_TABLE[((b2 & 0xf) << 1) | (b3 >> 7)]);
    push(ENCODE_TABLE[(b3 >> 2) & 0x1f]);
    push(ENCODE_TABLE[(b3 & 3) << 3]);
    push('=');
  }
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
  try {
    const data = await readAll(io.stdin);
    if (decode) {
      const text = new TextDecoder().decode(data);
      const decoded = b32Decode(text);
      if (decoded === null) {
        return await exitWith(err, 1, `${name}: invalid input`);
      }
      await out.write(decoded);
    } else {
      await writeString(out, b32Encode(data, wrap));
    }
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(base32Command);
export { base32Command };

/**
 * `base64` — encode/decode data in base64.
 *
 * Flags:
 *   -d / --decode   decode instead of encode
 *   -w N / --wrap=N wrap encoded output at N columns (default 76; 0 = no wrap)
 */
import { defineCommand, parseArgs, readAll, writeString, exitWith } from '../harness.ts';
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
    try {
      const data = await readAll(io.stdin);
      if (decode) {
        const text = new TextDecoder().decode(data);
        const decoded = b64Decode(text);
        if (decoded === null) {
          return await exitWith(err, 1, `${name}: invalid input`);
        }
        await out.write(decoded);
      } else {
        await writeString(out, b64Encode(data, wrap));
      }
      return 0;
    } finally {
      await out.close().catch(() => { /* already closed */ });
      await err.close().catch(() => { /* already closed */ });
    }
  };
}

const base64Command = makeBase64Command('base64');

export default defineCommand(base64Command);
export { base64Command };

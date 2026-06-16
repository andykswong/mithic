/**
 * `cksum` — print CRC32 checksum and byte count of each file.
 * `sum` — print BSD checksum (16-bit sum) and block count (512-byte blocks).
 *
 * cksum uses CRC-32 (the POSIX cksum polynomial, same as used in Ethernet/ZIP).
 * sum uses the traditional BSD algorithm: sum of all bytes mod 65536, plus
 * number of 512-byte blocks.
 *
 * Usage: cksum [FILE...]    (or stdin if no files)
 *        sum [FILE...]
 */
import { defineCommand, parseArgs, readAll, writeLine } from '../harness.ts';
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
  // POSIX cksum appends the length as bytes and 4-byte big-endian
  // (the POSIX variant processes length into the CRC, not just XOR with ~)
  // We implement the simpler GNU cksum which just finalises with ~crc >>> 0
  return (~crc) >>> 0;
}

// ── BSD sum (sum -s, the default) ────────────────────────────────────────────

export function bsdSum(data: Uint8Array): { checksum: number; blocks: number } {
  let s = 0;
  for (const b of data) {
    s = ((s >> 1) + ((s & 1) << 15) + b) & 0xffff;
  }
  const blocks = Math.ceil(data.length / 512);
  return { checksum: s, blocks };
}

// ── shared file reader ────────────────────────────────────────────────────────

async function readFileOrStdin(io: CommandIO, path: string): Promise<Uint8Array> {
  if (path === '-') return readAll(io.stdin);
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk); total += chunk.byteLength;
    }
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
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
        let data: Uint8Array;
        try { data = await readFileOrStdin(io, src); }
        catch {
          await writeLine(err, `${name}: ${src}: No such file or directory`);
          exitCode = 1;
          continue;
        }
        const label = src === '-' ? '' : ' ' + src;
        if (isCksum) {
          await writeLine(out, `${crc32(data)} ${data.length}${label}`);
        } else {
          const { checksum, blocks } = bsdSum(data);
          await writeLine(out, `${String(checksum).padStart(5)} ${String(blocks).padStart(5)}${label}`);
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

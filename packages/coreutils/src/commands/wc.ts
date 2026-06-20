/**
 * `wc` — print newline, word, and byte/char counts for each file.
 *
 * Supported:
 *   - `-l` lines, `-w` words, `-c` bytes, `-m` chars. Default: `-l -w -c`.
 *   - operands: file paths; `-` (or none) reads stdin.
 *   - multiple files: prints a final `total` line.
 *
 * Counts are printed in the fixed order lines, words, chars/bytes (only the
 * selected ones), each right-aligned, followed by the file name.
 */
import { defineCommand, parseArgs, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFile(io: CommandIO, path: string): Promise<Uint8Array> {
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

interface Counts { lines: number; words: number; chars: number; bytes: number; }

function count(bytes: Uint8Array): Counts {
  const text = new TextDecoder().decode(bytes);
  let lines = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) lines++;
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  // chars = Unicode code points; bytes = raw byte length.
  const chars = [...text].length;
  return { lines, words, chars, bytes: bytes.byteLength };
}

const WS = /\s/;

/**
 * Count a stream INCREMENTALLY without buffering it (the parity fix: a producer
 * piped into `wc` must drain chunk-wise, not be slurped whole). Words and chars
 * are tracked across chunk boundaries: `inWord` carries word state, and the
 * TextDecoder runs in streaming mode so a multibyte sequence split across chunks
 * counts as one code point.
 */
async function countStream(stream: ReadableStream<Uint8Array>): Promise<Counts> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const c: Counts = { lines: 0, words: 0, chars: 0, bytes: 0 };
  let inWord = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      c.bytes += value.byteLength;
      for (let i = 0; i < value.byteLength; i++) if (value[i] === 0x0a) c.lines++;
      const text = decoder.decode(value, { stream: true });
      for (const ch of text) {
        c.chars++;
        if (WS.test(ch)) inWord = false;
        else if (!inWord) { inWord = true; c.words++; }
      }
    }
    for (const _ of decoder.decode()) c.chars++; // flush any trailing partial char
  } finally {
    reader.releaseLock();
  }
  return c;
}

const wcCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['l', 'w', 'c', 'm', 'lines', 'words', 'bytes', 'chars'],
    alias: { lines: 'l', words: 'w', bytes: 'c', chars: 'm' },
  });
  const name = io.args[0] ?? 'wc';

  const showL = Boolean(flags.l);
  const showW = Boolean(flags.w);
  const showC = Boolean(flags.c);
  const showM = Boolean(flags.m);
  const anySelected = showL || showW || showC || showM;
  const sel = anySelected ? { l: showL, w: showW, c: showC, m: showM } : { l: true, w: true, c: true, m: false };

  const sources = positionals.length > 0 ? positionals : ['-'];
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;

  const total: Counts = { lines: 0, words: 0, chars: 0, bytes: 0 };
  let fileCount = 0;

  const format = (c: Counts, label: string): string => {
    const fields: number[] = [];
    if (sel.l) fields.push(c.lines);
    if (sel.w) fields.push(c.words);
    if (sel.m) fields.push(c.chars);
    if (sel.c) fields.push(c.bytes);
    const body = fields.map((n) => String(n).padStart(7, ' ')).join('');
    return label ? `${body} ${label}\n` : `${body}\n`;
  };

  try {
    for (const src of sources) {
      let c: Counts;
      if (src === '-') {
        c = await countStream(io.stdin);
      } else {
        try { c = count(await readFile(io, src)); }
        catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeString(err, `${name}: ${src}: ${msg}\n`);
          exitCode = 1;
          continue;
        }
      }
      total.lines += c.lines; total.words += c.words; total.chars += c.chars; total.bytes += c.bytes;
      fileCount++;
      const label = src === '-' ? '' : src;
      await writeString(out, format(c, label));
    }
    if (fileCount > 1) await writeString(out, format(total, 'total'));
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
  return exitCode;
};

export default defineCommand(wcCommand);
export { wcCommand };

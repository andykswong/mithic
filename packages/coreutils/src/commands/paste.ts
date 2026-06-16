/**
 * `paste` — merge lines of files.
 *
 * Supported:
 *   - default: merge corresponding lines of all files, TAB-separated.
 *   - `-d LIST`: cycle through delimiter chars in LIST (`\t`, `\n`, `\0`, `\\`).
 *   - `-s`: serial — concatenate all lines of each file onto one line.
 *   - operands: file paths; `-` (or none) reads stdin.
 */
import { defineCommand, parseArgs, readAllText, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFileText(io: CommandIO, path: string): Promise<string> {
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
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(buf);
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/** Expand a -d LIST into delimiter chars, honoring `\t \n \0 \\`. */
export function parseDelims(spec: string): string[] {
  if (spec === '') return [''];
  const out: string[] = [];
  let i = 0;
  while (i < spec.length) {
    if (spec[i] === '\\' && i + 1 < spec.length) {
      const map: Record<string, string> = { t: '\t', n: '\n', '0': '', '\\': '\\' };
      out.push(map[spec[i + 1]] ?? spec[i + 1]);
      i += 2;
    } else { out.push(spec[i]); i++; }
  }
  return out.length > 0 ? out : [''];
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

const pasteCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['d', 'delimiters'],
    boolean: ['s', 'serial'],
    alias: { delimiters: 'd', serial: 's' },
  });
  const name = io.args[0] ?? 'paste';
  const delims = flags.d !== undefined ? parseDelims(String(flags.d)) : ['\t'];
  const serial = Boolean(flags.s);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;

  try {
    const sources = positionals.length > 0 ? positionals : ['-'];
    const fileLines: string[][] = [];
    for (const src of sources) {
      let text: string;
      if (src === '-') text = await readAllText(io.stdin);
      else {
        try { text = await readFileText(io, src); }
        catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeString(err, `${name}: ${src}: ${msg}\n`);
          exitCode = 1;
          continue;
        }
      }
      fileLines.push(splitLines(text));
    }

    if (serial) {
      // One output line per file: that file's lines joined by cycling delims.
      const outLines = fileLines.map((lines) =>
        lines.map((l, idx) => (idx === 0 ? l : delims[(idx - 1) % delims.length] + l)).join(''),
      );
      if (outLines.length > 0) await writeString(out, outLines.join('\n') + '\n');
    } else {
      // Merge: row r takes line r from each file, joined by cycling delims.
      const maxLines = fileLines.reduce((m, l) => Math.max(m, l.length), 0);
      const rows: string[] = [];
      for (let r = 0; r < maxLines; r++) {
        let row = '';
        for (let f = 0; f < fileLines.length; f++) {
          if (f > 0) row += delims[(f - 1) % delims.length];
          row += fileLines[f][r] ?? '';
        }
        rows.push(row);
      }
      if (rows.length > 0) await writeString(out, rows.join('\n') + '\n');
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(pasteCommand);
export { pasteCommand };

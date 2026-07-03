/**
 * `fold` — wrap each input line to fit a given width.
 *
 * Supported (GNU parity):
 *   - `-w N` / `--width=N`: wrap at N columns (default 80).
 *   - obsolete `-N` (e.g. `-3`): same as `-w N`.
 *   - `-b` / `--bytes`: count bytes rather than display columns (no tab/BS/CR
 *     column handling; a multibyte char is measured by its byte length).
 *   - `-s` / `--spaces`: break at the last blank within the width when possible.
 *   - operands: file paths; `-` (or none) reads stdin.
 *
 * Char mode tracks the display column exactly like GNU: a tab advances to the
 * next multiple of 8, a backspace decrements, a carriage return resets to 0.
 */
import { CoalescingWriter, defineCommand, exitWith, isBrokenPipe, optionError, parseArgs, streamLines, writeBytes, writeString } from '../harness.ts';
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

const ENC = new TextEncoder();
const NL = new Uint8Array([0x0a]);

/**
 * Display width of a code point (char mode), matching `wcwidth`: combining marks
 * are 0, CJK/fullwidth ranges are 2, everything else 1. A pragmatic subset of the
 * East-Asian-Width table — enough for the common wide-char cases GNU `fold` (and
 * `wc -L`) treats as double-width.
 */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) || cp === 0x200b || cp === 0x200c ||
    cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)
  ) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Column reached after emitting the code point `cp` starting from `col`. */
function advanceColumn(col: number, cp: number, byteMode: boolean): number {
  if (byteMode) return col + utf8Length(cp); // width = the char's byte length
  if (cp === 0x08) return col > 0 ? col - 1 : 0; // backspace
  if (cp === 0x0d) return 0; // carriage return
  if (cp === 0x09) return (Math.floor(col / 8) + 1) * 8; // tab → next multiple of 8
  return col + charWidth(cp);
}

/** UTF-8 encoded byte length of a code point. */
function utf8Length(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/**
 * Fold one input line (no trailing newline) to `width`. Matches GNU `fold`:
 * the unit is always a full code point (never split, even in `-b` byte mode);
 * when appending it would push the column past `width` and the current line has
 * content, the line is flushed first (backing up to the last blank when `-s`).
 * Char mode measures display columns (tab/BS/CR + wcwidth); byte mode measures
 * the code point's UTF-8 byte length. Bytes stay byte-exact.
 */
export function foldBytes(line: string, width: number, atSpaces: boolean, byteMode: boolean): Uint8Array {
  const units = [...line];
  const segments: string[][] = [];
  let cur: string[] = [];
  let col = 0;
  for (const u of units) {
    const cp = u.codePointAt(0)!;
    const next = advanceColumn(col, cp, byteMode);
    if (next > width && cur.length > 0) {
      let breakAt = cur.length; // default: break before this unit (at width)
      if (atSpaces) {
        for (let i = cur.length - 1; i > 0; i--) {
          if (cur[i - 1] === ' ' || cur[i - 1] === '\t') { breakAt = i; break; }
        }
      }
      segments.push(cur.slice(0, breakAt));
      cur = cur.slice(breakAt);
      col = 0;
      for (const c of cur) col = advanceColumn(col, c.codePointAt(0)!, byteMode);
      col = advanceColumn(col, cp, byteMode);
    } else {
      col = next;
    }
    cur.push(u);
  }
  segments.push(cur);
  return ENC.encode(segments.map((s) => s.join('')).join('\n'));
}

/** String-returning convenience over {@link foldBytes} (used by unit tests). */
export function foldLine(line: string, width: number, atSpaces: boolean, byteMode = false): string {
  return new TextDecoder().decode(foldBytes(line, width, atSpaces, byteMode));
}

/**
 * Parse fold's options, honoring the obsolete `-N` width form (e.g. `-3`).
 * Returns the resolved options or an error to report. Because `-3` looks like an
 * option cluster, we pre-scan argv for a leading-digit token and rewrite it to
 * `-w N` before the generic parser runs.
 */
function normalizeArgs(argv: string[]): string[] {
  const out: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (afterDashDash) { out.push(a); continue; }
    if (a === '--') { afterDashDash = true; out.push(a); continue; }
    // Obsolete width: -DIGITS (optionally with leading b/s flags, e.g. -b3 handled
    // by the generic parser as -b -3? No: -b3 means -b -w 3). Match a run that is
    // all digits after the dash, or flag chars then digits.
    const m = /^-([bs]*)(\d+)$/.exec(a);
    if (m) {
      if (m[1]) out.push('-' + m[1]);
      out.push('-w', m[2]);
      continue;
    }
    out.push(a);
  }
  return out;
}

const foldCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(normalizeArgs(io.args.slice(1)), {
    string: ['w', 'width'],
    boolean: ['s', 'spaces', 'b', 'bytes'],
    alias: { width: 'w', spaces: 's', bytes: 'b' },
    unknown: 'error',
  });
  const name = io.args[0] ?? 'fold';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();

  if (parsed.unknown.length) {
    try { return await exitWith(err, 1, optionError(name, parsed.unknown[0])); }
    finally { await out.close().catch(() => {}); await err.close().catch(() => {}); }
  }

  const { positionals, flags } = parsed;
  const width = flags.w !== undefined ? Number(flags.w) : 80;
  const atSpaces = Boolean(flags.s);
  const byteMode = Boolean(flags.b);

  let exitCode = 0;
  let stdinAborted = false;

  try {
    if (!(width > 0)) {
      await writeString(err, `${name}: invalid number of columns\n`);
      return 1;
    }
    const sources = positionals.length > 0 ? positionals : ['-'];
    for (const src of sources) {
      if (src === '-') {
        const sink = new CoalescingWriter(out);
        try {
          for await (const { line, eol } of streamLines(io.stdin)) {
            if (byteMode) {
              // Write raw bytes so multibyte input stays byte-exact.
              await sink.flush();
              await writeBytes(out, foldBytes(line, width, atSpaces, true));
              if (eol) await writeBytes(out, NL);
            } else {
              await sink.push(foldLine(line, width, atSpaces, false) + (eol ? '\n' : ''));
            }
          }
          await sink.flush();
        } catch (e) {
          if (isBrokenPipe(e)) { stdinAborted = true; break; }
          throw e;
        }
        continue;
      }
      let text: string;
      try { text = await readFileText(io, src); }
      catch (e) {
        await writeString(err, `${name}: ${src}: ${(e as { message?: string }).message ?? 'No such file or directory'}\n`);
        exitCode = 1;
        continue;
      }
      if (text === '') continue;
      const hasTrailing = text.endsWith('\n');
      const body = hasTrailing ? text.slice(0, -1) : text;
      const lines = body.split('\n');
      if (byteMode) {
        for (let i = 0; i < lines.length; i++) {
          await writeBytes(out, foldBytes(lines[i], width, atSpaces, true));
          if (i < lines.length - 1 || hasTrailing) await writeBytes(out, NL);
        }
        continue;
      }
      const outParts: string[] = [];
      for (const line of lines) outParts.push(foldLine(line, width, atSpaces, false));
      await writeString(out, outParts.join('\n') + (hasTrailing ? '\n' : ''));
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
};

export default defineCommand(foldCommand);
export { foldCommand };

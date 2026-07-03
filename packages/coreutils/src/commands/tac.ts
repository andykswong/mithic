/**
 * `tac` — concatenate and print files with records in reverse order.
 *
 * Supported (GNU parity):
 *   - `-s SEP` record separator (default newline). Attached to the record it
 *     follows (trailing) unless `-b` moves it before the following record.
 *   - `-b` / `--before` attach the separator to the following record.
 *   - `-r` / `--regex` treat SEP as a POSIX extended regular expression (mapped
 *     to a JS RegExp; matched greedily, unlike GNU's backward-scan artifact for
 *     variable-length matches such as `[0-9]+` on adjacent runs).
 *   - operands: file paths; `-` (or none) reads stdin.
 *
 * Records are split on the separator; a trailing empty record (input ending with
 * a separator) is dropped, so a file with no trailing separator produces no
 * spurious newline (matching GNU).
 */
import { defineCommand, exitWith, optionError, parseArgs, readAll, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFile(io: CommandIO, path: string): Promise<Uint8Array> {
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk); total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reverse `text` by records split on `sepRe`. In trailing mode each record keeps
 * its following separator; in before mode the separator leads the next record.
 * A trailing empty record (text ending on a separator) is dropped.
 */
function tacText(text: string, sepRe: RegExp, before: boolean): string {
  if (text === '') return '';
  // Collect separator match spans.
  const spans: { start: number; end: number }[] = [];
  const re = new RegExp(sepRe.source, sepRe.flags.includes('g') ? sepRe.flags : sepRe.flags + 'g');
  let m: RegExpExecArray | null;
  let last = -1;
  while ((m = re.exec(text)) !== null) {
    // Guard against zero-width matches spinning forever.
    if (m.index === re.lastIndex) re.lastIndex++;
    if (m[0] === '') continue;
    if (m.index < last) continue;
    spans.push({ start: m.index, end: m.index + m[0].length });
    last = m.index + m[0].length;
  }
  if (spans.length === 0) return text;

  const records: string[] = [];
  if (before) {
    // Record boundary is BEFORE each separator: [text..sep0), [sep0..sep1), …
    records.push(text.slice(0, spans[0].start));
    for (let i = 0; i < spans.length; i++) {
      const nextStart = i + 1 < spans.length ? spans[i + 1].start : text.length;
      records.push(text.slice(spans[i].start, nextStart));
    }
  } else {
    // Record boundary is AFTER each separator: [0..sep0end), [sep0end..sep1end), …
    let pos = 0;
    for (const s of spans) { records.push(text.slice(pos, s.end)); pos = s.end; }
    if (pos < text.length) records.push(text.slice(pos)); // final unterminated record
  }
  return records.reverse().join('');
}

const tacCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'tac';
  const parsed = parseArgs(io.args.slice(1), {
    string: ['s', 'separator', 'regex'],
    boolean: ['b', 'before', 'r'],
    alias: { separator: 's', before: 'b' },
    unknown: 'error',
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();

  const done = async (code: number, msg?: string): Promise<number> => {
    try { return await exitWith(err, code, msg); }
    finally { await out.close().catch(() => {}); await err.close().catch(() => {}); }
  };

  if (parsed.unknown.length) return done(1, optionError(name, parsed.unknown[0]));

  const { positionals, flags } = parsed;
  const before = Boolean(flags.b);
  const useRegex = Boolean(flags.r) || flags.regex !== undefined;
  const sepStr = flags.regex !== undefined ? String(flags.regex)
    : flags.s !== undefined ? String(flags.s) : '\n';

  let sepRe: RegExp;
  try {
    sepRe = new RegExp(useRegex ? sepStr : escapeRegExp(sepStr));
  } catch {
    return done(1, `${name}: Invalid regular expression`);
  }

  const sources = positionals.length > 0 ? positionals : ['-'];
  let exitCode = 0;
  try {
    for (const src of sources) {
      let bytes: Uint8Array;
      if (src === '-') {
        bytes = await readAll(io.stdin);
      } else {
        try {
          bytes = await readFile(io, src);
        } catch (e) {
          await writeString(err, `${name}: ${src}: ${(e as { message?: string }).message ?? 'No such file or directory'}\n`);
          exitCode = 1;
          continue;
        }
      }
      const text = new TextDecoder().decode(bytes);
      if (text === '') continue;
      await writeString(out, tacText(text, sepRe, before));
    }
    return exitCode;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(tacCommand);
export { tacCommand, tacText };

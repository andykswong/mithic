/**
 * `nl` — number lines.
 *
 * Supported (GNU parity):
 *   - `-b STYLE` body numbering: `a` all, `t` non-empty (default), `n` none,
 *     `pBRE` only lines matching the basic regular expression BRE.
 *   - `-v N` first line number (default 1); `-i N` increment (default 1).
 *   - `-w N` number field width (default 6).
 *   - `-n FORMAT` number format: `ln` left-justified, `rn` right-justified
 *     (default), `rz` right-justified zero-padded.
 *   - `-s STR` separator between number and line (default TAB).
 *   - `-l N` group N consecutive blank lines as one (join blank lines).
 *   - operands: file paths; `-` (or none) reads stdin.
 *
 * Non-numbered lines are emitted with `width + separator` blank columns so the
 * text aligns under numbered lines.
 */
import {
  CoalescingWriter, defineCommand, exitWith, isBrokenPipe, optionError, parseArgs, streamLines, writeString,
} from '../harness.ts';
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

/**
 * Translate a POSIX basic regular expression (BRE) to a JS RegExp. In a BRE the
 * metacharacters `+ ? { } | ( )` are literal, while `\+ \? \{ \} \( \) \|` are
 * the operators; `nl`'s `-b p` uses this dialect. We swap escaped/unescaped forms
 * and escape the JS-special chars that a BRE treats literally.
 */
function breToRegExp(bre: string): RegExp {
  let out = '';
  for (let i = 0; i < bre.length; i++) {
    const ch = bre[i];
    if (ch === '\\' && i + 1 < bre.length) {
      const n = bre[i + 1];
      // \( \) \{ \} \+ \? \| are operators in a BRE → drop the backslash for JS.
      if ('(){}+?|'.includes(n)) { out += n; i++; continue; }
      out += '\\' + n; i++; continue;
    }
    // Literal in a BRE but special in JS → escape.
    if ('(){}+?|'.includes(ch)) { out += '\\' + ch; continue; }
    out += ch;
  }
  return new RegExp(out);
}

const nlCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(io.args.slice(1), {
    string: [
      'b', 'w', 's', 'v', 'i', 'n', 'l',
      'body-numbering', 'number-width', 'number-separator',
      'starting-line-number', 'line-increment', 'number-format', 'join-blank-lines',
    ],
    alias: {
      'body-numbering': 'b', 'number-width': 'w', 'number-separator': 's',
      'starting-line-number': 'v', 'line-increment': 'i', 'number-format': 'n',
      'join-blank-lines': 'l',
    },
    unknown: 'error',
  });
  const name = io.args[0] ?? 'nl';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();

  const fail = async (code: number, msg?: string): Promise<number> => {
    try { return await exitWith(err, code, msg); }
    finally { await out.close().catch(() => {}); await err.close().catch(() => {}); }
  };

  if (parsed.unknown.length) return fail(1, optionError(name, parsed.unknown[0]));

  const { positionals, flags } = parsed;
  const bodyStyle = flags.b !== undefined ? String(flags.b) : 't'; // a|t|n|pBRE
  const width = flags.w !== undefined ? Number(flags.w) : 6;
  const sep = flags.s !== undefined ? String(flags.s) : '\t';
  const startNo = flags.v !== undefined ? Number(flags.v) : 1;
  const increment = flags.i !== undefined ? Number(flags.i) : 1;
  const numFormat = flags.n !== undefined ? String(flags.n) : 'rn'; // ln|rn|rz
  const joinBlank = flags.l !== undefined ? Math.max(1, Number(flags.l)) : 1;

  if (numFormat !== 'ln' && numFormat !== 'rn' && numFormat !== 'rz') {
    return fail(1, `${name}: invalid line numbering format: '${flags.n}'`);
  }
  let bodyRe: RegExp | undefined;
  if (bodyStyle[0] === 'p') {
    bodyRe = breToRegExp(bodyStyle.slice(1));
  } else if (bodyStyle !== 'a' && bodyStyle !== 't' && bodyStyle !== 'n') {
    return fail(1, `${name}: invalid body numbering style: '${bodyStyle}'`);
  }

  const blank = ' '.repeat(width + sep.length);
  const formatNumber = (n: number): string => {
    const s = String(n);
    if (numFormat === 'ln') return s.padEnd(width, ' ');
    if (numFormat === 'rz') return s.padStart(width, '0');
    return s.padStart(width, ' ');
  };

  let lineNo = startNo;
  let blankRun = 0; // consecutive empty lines seen (for -l join-blank-lines)

  // Decide whether to number a line and produce its output prefix. `-l N` joins
  // runs of N empty lines: only the Nth empty line in a run is a numbering
  // candidate; the run counter resets after it.
  const numberLine = (line: string): string => {
    let numberThis: boolean;
    if (line === '') {
      blankRun++;
      const eligible = blankRun >= joinBlank;
      if (eligible) blankRun = 0;
      // Empty lines are numbered under `a` (all) or a matching `p` regex, but
      // only when this empty line closes a join-run of `-l N`.
      numberThis = eligible && (bodyStyle === 'a' || (bodyRe !== undefined && bodyRe.test(line)));
    } else {
      blankRun = 0;
      numberThis =
        bodyStyle === 'a' ||
        (bodyStyle === 't' && line !== '') ||
        (bodyRe !== undefined && bodyRe.test(line));
    }
    if (numberThis) {
      const prefix = formatNumber(lineNo) + sep;
      lineNo += increment;
      return prefix + line;
    }
    return blank + line;
  };

  let exitCode = 0;
  let stdinAborted = false;
  try {
    const sources = positionals.length > 0 ? positionals : ['-'];
    for (const src of sources) {
      if (src === '-') {
        const sink = new CoalescingWriter(out);
        try {
          // GNU `nl` terminates every output line with a newline, even when the
          // input's final line was unterminated.
          for await (const { line } of streamLines(io.stdin)) {
            await sink.push(numberLine(line) + '\n');
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
      // Split into lines, dropping only a single trailing newline; every emitted
      // line is newline-terminated (GNU parity), even an unterminated last line.
      const body = text.endsWith('\n') ? text.slice(0, -1) : text;
      const lines = body.split('\n');
      const outParts: string[] = [];
      for (const line of lines) outParts.push(numberLine(line) + '\n');
      await writeString(out, outParts.join(''));
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
};

export default defineCommand(nlCommand);
export { nlCommand, breToRegExp };

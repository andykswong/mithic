/**
 * `column` — columnate lists.
 *
 * Forms:
 *   column [-t] [-s SEP] [FILE...]
 *     -t        create a table: split each line into fields, compute per-column
 *               max widths, print left-aligned cells with a 2-space gutter.
 *     -s SEP    field separator for -t (default: runs of whitespace)
 *
 * The `-t` table mode is faithful to GNU `column -t` (2-space inter-column gap,
 * trailing column not padded, ragged rows align by column index).
 *
 * The default (non-`-t`) "fill" mode is a SIMPLIFIED model: entries (one per
 * input line) are packed left-to-right into rows wrapping at 80 columns, sized
 * to the widest entry + a 2-space gutter. GNU's fill mode is column-major and
 * honours `$COLUMNS`; this row-major 80-col fill is documented as a deliberate
 * simplification (the table mode is the high-value path).
 */
import { defineCommand, parseArgs, readAllText, writeString } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const TERM_WIDTH = 80;
const GUTTER = 2;

/** Split a line into fields. `sep` undefined ⇒ split on whitespace runs. */
function fields(line: string, sep: string | undefined): string[] {
  if (sep === undefined) return line.trim() === '' ? [] : line.trim().split(/\s+/);
  return line.split(sep);
}

/** Render `-t` table output for `rows` (already split into fields). */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) widths[c] = Math.max(widths[c] ?? 0, row[c].length);
  }
  let out = '';
  for (const row of rows) {
    let line = '';
    for (let c = 0; c < row.length; c++) {
      // The last populated cell of the row is not right-padded.
      if (c === row.length - 1) line += row[c];
      else line += row[c].padEnd(widths[c] + GUTTER);
    }
    out += line + '\n';
  }
  return out;
}

/** Render the simplified 80-column fill for a list of `entries`. */
export function fill(entries: string[]): string {
  if (entries.length === 0) return '';
  const width = Math.max(...entries.map((e) => e.length)) + GUTTER;
  const perLine = Math.max(1, Math.floor(TERM_WIDTH / width));
  let out = '';
  for (let i = 0; i < entries.length; i++) {
    const last = i === entries.length - 1 || (i + 1) % perLine === 0;
    out += last ? entries[i] + '\n' : entries[i].padEnd(width);
  }
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

const columnCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'column';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['t'],
    string: ['s'],
    alias: { table: 't', separator: 's' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    const src = positionals[0];
    let text: string;
    if (src === undefined || src === '-') text = await readAllText(io.stdin);
    else {
      try { text = new TextDecoder().decode(await readFile(io, src)); }
      catch { await writeString(err, `${name}: ${src}: No such file or directory\n`); return 1; }
    }
    if (text === '') return 0;
    const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

    if (flags.t) {
      const sep = flags.s !== undefined ? String(flags.s) : undefined;
      const rows = lines.map((l) => fields(l, sep));
      await writeString(out, table(rows));
    } else {
      // Fill mode: each non-empty input line is one entry.
      await writeString(out, fill(lines.filter((l) => l !== '')));
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(columnCommand);
export { columnCommand };

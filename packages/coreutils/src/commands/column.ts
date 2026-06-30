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
 * The default (non-`-t`) "fill" mode is column-major fill with a UNIFORM column
 * width (the util-linux `columnate_fillcols` model): one width `colw = maxlen +
 * gutter` is derived from the WIDEST entry, the column count is the direct
 * division `cols = max(1, floor(width / colw))`, and entries are laid DOWN each
 * column then across (`entries[c*rows + r]`). Every cell is padded to the uniform
 * `colw` except the last populated cell in a row (no trailing whitespace).
 *
 * Residual simplifications (NOT full util-linux parity for fill mode):
 *   - entries are whole input lines, not whitespace-split words — util-linux
 *     splits on whitespace so `printf 'a b\nc d\n' | column` yields 4 entries,
 *     whereas this yields 2 (one per line);
 *   - the line width is a fixed 80 columns rather than honouring `$COLUMNS`.
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

/**
 * Column-major fill with a uniform column width (util-linux `column` default
 * mode, `columnate_fillcols`): one width `colw = maxlen + {@link GUTTER}` is
 * derived from the WIDEST entry; the column count is the direct division
 * `cols = max(1, floor({@link TERM_WIDTH} / colw))`; entries are laid DOWN each
 * column then across (`entries[c*rows + r]`). Every cell is padded to the
 * uniform `colw` except the last populated cell in a row (no trailing ws).
 */
export function fill(entries: string[]): string {
  const n = entries.length;
  if (n === 0) return '';

  let maxlen = 0;
  for (const e of entries) maxlen = Math.max(maxlen, e.length);

  const colw = maxlen + GUTTER;
  const cols = Math.max(1, Math.floor(TERM_WIDTH / colw));
  const rows = Math.ceil(n / cols);

  let out = '';
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const e = entries[c * rows + r];
      if (e === undefined) continue;       // missing trailing entry
      const isLastInRow = c === cols - 1 || entries[(c + 1) * rows + r] === undefined;
      line += isLastInRow ? e : e.padEnd(colw);
    }
    out += line + '\n';
  }
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

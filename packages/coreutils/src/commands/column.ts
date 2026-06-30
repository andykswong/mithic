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
 * The default (non-`-t`) "fill" mode is column-major (GNU): entries (one per
 * input line) are laid DOWN each column then across. The column count is the
 * largest whose laid-out width (sum of per-column max-widths + 2-space gutters)
 * fits the line; each column is padded to its own max entry width + gutter, the
 * last column unpadded. Residual simplification: the line width is a fixed 80
 * columns rather than honouring `$COLUMNS`.
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
 * Column-major fill (GNU `column` default mode): entries are laid DOWN each
 * column then across. The column count is the largest whose laid-out width
 * (sum of per-column max-widths + gutters) fits {@link TERM_WIDTH}; each column
 * is padded to its own max entry width + {@link GUTTER}, last column unpadded.
 */
export function fill(entries: string[]): string {
  const n = entries.length;
  if (n === 0) return '';

  // Per-column widths for a given column count, laid out column-major.
  const layout = (cols: number): { rows: number; widths: number[] } => {
    const rows = Math.ceil(n / cols);
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
      let w = 0;
      for (let r = 0; r < rows; r++) {
        const e = entries[c * rows + r];
        if (e !== undefined) w = Math.max(w, e.length);
      }
      widths[c] = w;
    }
    return { rows, widths };
  };
  const lineWidth = (widths: number[]): number =>
    widths.reduce((s, w) => s + w, 0) + GUTTER * (widths.length - 1);

  // Largest column count that fits; always at least 1.
  let cols = 1;
  for (let c = n; c >= 1; c--) {
    if (lineWidth(layout(c).widths) <= TERM_WIDTH) { cols = c; break; }
  }

  const { rows, widths } = layout(cols);
  let out = '';
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const e = entries[c * rows + r];
      if (e === undefined) continue;       // missing trailing entry
      const isLastInRow = c === cols - 1 || entries[(c + 1) * rows + r] === undefined;
      line += isLastInRow ? e : e.padEnd(widths[c] + GUTTER);
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

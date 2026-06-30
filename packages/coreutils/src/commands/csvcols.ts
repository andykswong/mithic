/**
 * `csvcols` — project a CSV file down to (and reorder) named columns.
 *
 *   COLS=a,c  csvcols IN OUT
 *
 * Reads IN, keeps only the columns named in the `COLS` env var (in the order
 * listed there), and writes the result to OUT — all by VFS path-arg via the
 * standard File System Access surface (`readPath`/`writePath`). CSV data is
 * legitimately text, so this decodes UTF-8; the binary-fidelity path is `copy`.
 *
 * Parsing is intentionally minimal (split on `\n`, then `,`): no quoting or
 * embedded-newline handling. That keeps the first utility small; the Lab can
 * graduate to a real CSV parser later.
 */
import { readPath, writePath } from '@mithic/guest-runtime';
import { defineCommand, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { pathContext } from '../path-context.ts';

const csvcolsCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const [, src, dst] = io.args;
  const err = io.stderr.getWriter();
  try {
    if (src === undefined || dst === undefined) {
      await writeLine(err, 'csvcols: usage: COLS=col,... csvcols IN OUT');
      return 1;
    }
    const cols = (io.env.COLS ?? '').split(',').map((c) => c.trim()).filter((c) => c !== '');
    if (cols.length === 0) {
      await writeLine(err, 'csvcols: COLS must name at least one column');
      return 1;
    }

    const g = pathContext(io);
    let text: string;
    try {
      text = new TextDecoder().decode(await readPath(g, src));
    } catch (e) {
      await writeLine(err, `csvcols: ${(e as Error).message}`);
      return 1;
    }

    const trailingNewline = text.endsWith('\n');
    const rows = (trailingNewline ? text.slice(0, -1) : text).split('\n');
    if (rows.length === 0 || rows[0] === '') {
      await writeLine(err, 'csvcols: empty input (no header row)');
      return 1;
    }

    const header = rows[0].split(',');
    const indices: number[] = [];
    for (const col of cols) {
      const idx = header.indexOf(col);
      if (idx === -1) {
        await writeLine(err, `csvcols: unknown column: ${col}`);
        return 1;
      }
      indices.push(idx);
    }

    const projected = rows.map((row) => {
      const fields = row.split(',');
      return indices.map((i) => fields[i] ?? '').join(',');
    });
    const out = projected.join('\n') + (trailingNewline ? '\n' : '');

    try {
      await writePath(g, dst, new TextEncoder().encode(out));
      return 0;
    } catch (e) {
      await writeLine(err, `csvcols: ${(e as Error).message}`);
      return 1;
    }
  } finally {
    await err.close().catch(() => {});
  }
};

export default defineCommand(csvcolsCommand);
export { csvcolsCommand };

/**
 * `unexpand` — convert runs of spaces to tabs.
 *
 * Forms:
 *   unexpand [-t N] [-a] [FILE...]
 *     -t N   tab stops every N columns (default 8)
 *     -a     convert all blanks, not just the leading run (the default only
 *            converts leading whitespace)
 *
 * A run of blanks that reaches a tab stop is replaced by a tab when doing so
 * shortens the output (i.e. at least two spaces collapse into the tab). A single
 * space landing on a stop is left as-is. The leading run (without -a) ends at the
 * first NON-blank: a literal tab is still leading whitespace (GNU), so it
 * advances the column to the next tab stop without ending conversion. Reads stdin
 * when FILE is `-`/omitted.
 */
import { defineCommand, parseArgs, readAllText, writeString, exitWith } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Convert blanks in one line to tabs at `tabstop` boundaries. */
function unexpandLine(line: string, tabstop: number, all: boolean): string {
  let out = '';
  let col = 0;
  let pending = 0;      // count of buffered spaces not yet emitted
  let convertible = true; // are we still in a region we may convert?

  const flushPending = (): void => {
    if (pending > 0) { out += ' '.repeat(pending); pending = 0; }
  };

  for (const ch of line) {
    if (ch === ' ' && convertible) {
      pending++;
      col++;
      // At a tab stop, collapse the buffered run if it spans >= 2 columns.
      if (col % tabstop === 0) {
        out += pending >= 2 ? '\t' : ' '.repeat(pending);
        pending = 0;
      }
    } else {
      flushPending();
      out += ch;
      col = ch === '\t' ? col + (tabstop - (col % tabstop)) : col + 1;
      // Without -a, the leading run ends at the first NON-blank. A literal tab
      // is still leading whitespace (GNU), so it advances the column above but
      // does not stop further leading conversion.
      if (!all && ch !== ' ' && ch !== '\t') convertible = false;
    }
  }
  flushPending();
  return out;
}

const unexpandCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'unexpand';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['a'],
    string: ['t'],
    alias: { all: 'a', tabs: 't', first: 'a' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    let tabstop = 8;
    if (flags.t !== undefined) {
      const n = Number(flags.t);
      if (!Number.isInteger(n) || n < 1) return await exitWith(err, 1, `${name}: tab size contains invalid character(s)`);
      tabstop = n;
    }
    const all = Boolean(flags.a);
    const sources = positionals.length > 0 ? positionals : ['-'];
    for (const src of sources) {
      let text: string;
      if (src === '-') text = await readAllText(io.stdin);
      else {
        try { text = new TextDecoder().decode(await readFile(io, src)); }
        catch { await writeString(err, `${name}: ${src}: No such file or directory\n`); continue; }
      }
      const hasTrailing = text.endsWith('\n');
      const body = hasTrailing ? text.slice(0, -1) : text;
      const converted = body.split('\n').map((l) => unexpandLine(l, tabstop, all)).join('\n');
      await writeString(out, converted + (hasTrailing ? '\n' : ''));
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(unexpandCommand);
export { unexpandCommand, unexpandLine };

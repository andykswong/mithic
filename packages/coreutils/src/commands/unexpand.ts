/**
 * `unexpand` — convert runs of spaces to tabs.
 *
 * Forms:
 *   unexpand [-t LIST] [-a] [FILE...]
 *     -t LIST   tab stops (default 8). A single N means every N columns; a
 *               comma/space-separated LIST gives explicit 1-based stop columns.
 *               Supplying any -t implies -a.
 *     -a        convert all blank runs, not just the leading run.
 *
 * A run of blanks reaching a tab stop is replaced by a tab when that shortens the
 * output (>= 2 columns collapse). A single space landing on a stop is left as-is.
 * Without -a (and without -t), only the leading blank run is converted; a literal
 * tab is still leading whitespace (GNU) and advances the column without ending
 * the leading run. Reads stdin when FILE is `-`/omitted.
 */
import { defineCommand, parseArgs, readAllText, writeString, exitWith, optionError } from '../harness.ts';
import { parseTabStops, collectFlagValues, TabError } from './expand.ts';
import type { TabStops } from './expand.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Convert blanks in one line to tabs at the given tab stops. */
function unexpandLine(line: string, tabs: TabStops, all: boolean): string {
  let out = '';
  let col = 0;
  let pending = 0;        // count of buffered spaces not yet emitted
  let convertible = true; // still in a region we may convert?

  const flushPending = (): void => {
    if (pending > 0) { out += ' '.repeat(pending); pending = 0; }
  };

  for (const ch of line) {
    if (ch === ' ' && convertible) {
      pending++;
      col++;
      // At a tab stop, collapse the buffered run if it spans >= 2 columns.
      if (tabs.isStop(col)) {
        out += pending >= 2 ? '\t' : ' '.repeat(pending);
        pending = 0;
      }
    } else {
      flushPending();
      out += ch;
      col = ch === '\t' ? tabs.nextStop(col) : col + 1;
      // Without -a, the leading run ends at the first NON-blank. A literal tab
      // is still leading whitespace (GNU): it advances the column but does not
      // stop further leading conversion.
      if (!all && ch !== ' ' && ch !== '\t') convertible = false;
    }
  }
  flushPending();
  return out;
}

const unexpandCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'unexpand';
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['a', 'all', 'first'],
    string: ['t', 'tabs'],
    alias: { all: 'a', tabs: 't', first: 'a' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (parsed.unknown.length) { await writeString(err, optionError(name, parsed.unknown[0]) + '\n'); return 1; }
    const tSpecs = collectFlagValues(io.args.slice(1), 't', 'tabs');
    let tabs: TabStops;
    try { tabs = parseTabStops(tSpecs); }
    catch (e) {
      if (e instanceof TabError) return await exitWith(err, 1, `${name}: ${e.message}`);
      throw e;
    }
    // Any -t implies -a (GNU): only the pure default restricts to leading blanks.
    const all = Boolean(flags.a) || tSpecs.length > 0;
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
      const converted = body.split('\n').map((l) => unexpandLine(l, tabs, all)).join('\n');
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

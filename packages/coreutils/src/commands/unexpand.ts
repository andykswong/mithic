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
import { parseTabStops, collectFlagValues, normalizeTabArgs, TabError } from './expand.ts';
import type { TabStops } from './expand.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/**
 * Convert blanks in one line to tabs at the given tab stops, matching GNU
 * `unexpand`. A blank RUN is committed at each tab stop the run reaches:
 *   - if the run continues PAST the stop (more blanks follow), the stretch up to
 *     the stop becomes a tab regardless of width (even a single space column);
 *   - if the run ENDS at the stop, it becomes a tab only when it spans >= 2
 *     columns (a lone space landing exactly on a stop stays a space);
 *   - the tail past the last reached stop (not itself a stop) stays as spaces.
 * Literal input tabs are re-emitted as tabs (advancing to the next stop). Without
 * -a only the leading blank run is convertible; a literal tab counts as leading.
 */
function unexpandLine(line: string, tabs: TabStops, all: boolean): string {
  let out = '';
  let col = 0;
  let convertible = true; // still in a region we may convert?
  const units = [...line];

  let i = 0;
  while (i < units.length) {
    const ch = units[i];
    if (ch === ' ' && convertible) {
      // Gather the whole run of spaces (and literal tabs, which we normalize).
      const runStart = col;
      let j = i;
      while (j < units.length && units[j] === ' ') { j++; col++; }
      // A literal tab inside the run is left alone by GNU's tabifier only when
      // it is itself a blank continuing the run; treat it as a run terminator
      // here (handled by the else branch below) — so the run is spaces only.
      const runEnd = col; // column just past the last space
      // A literal tab immediately after the space-run means the run of blanks
      // continues past runEnd (so a stop landing exactly on runEnd still tabs).
      const blankFollows = j < units.length && units[j] === '\t';
      // Walk the run, committing at each tab stop within (runStart, runEnd].
      let segStart = runStart;
      for (let c = runStart + 1; c <= runEnd; c++) {
        if (!tabs.isStop(c)) continue;
        const width = c - segStart;
        // A >= 2-column stretch always becomes a tab, as does a run anchored at
        // the left margin (segStart 0). A lone 1-column bridge elsewhere becomes
        // a tab only when the blank run continues past this stop AND a further tab
        // stop exists beyond it (so chaining is worthwhile) — matching GNU, which
        // leaves a single space before the LAST stop of an explicit list but tabs
        // before every stop of an every-N spec.
        const moreBlanksAfter = c < runEnd || blankFollows;
        const furtherStop = tabs.isStop(tabs.nextStop(c));
        const beneficial = width >= 2 || segStart === 0 || (moreBlanksAfter && furtherStop);
        out += beneficial ? '\t' : ' '.repeat(width);
        segStart = c;
      }
      // The remainder past the last stop (not a stop itself) stays as spaces.
      if (segStart < runEnd) out += ' '.repeat(runEnd - segStart);
      i = j;
      continue;
    }
    // Non-space (or non-convertible region): flush verbatim.
    out += ch;
    col = ch === '\t' ? tabs.nextStop(col) : col + 1;
    // Without -a, the leading run ends at the first NON-blank. A literal tab is
    // still leading whitespace (GNU): it advances the column but does not stop
    // further leading conversion.
    if (!all && ch !== ' ' && ch !== '\t') convertible = false;
    i++;
  }
  return out;
}

const unexpandCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'unexpand';
  const argv = normalizeTabArgs(io.args.slice(1));
  const parsed = parseArgs(argv, {
    boolean: ['a', 'all', 'first'],
    string: ['t', 'tabs'],
    alias: { all: 'a', tabs: 't', first: 'a' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  try {
    if (parsed.unknown.length) { await writeString(err, optionError(name, parsed.unknown[0]) + '\n'); return 1; }
    const tSpecs = collectFlagValues(argv, 't', 'tabs');
    let tabs: TabStops;
    try { tabs = parseTabStops(tSpecs); }
    catch (e) {
      if (e instanceof TabError) return await exitWith(err, 1, `${name}: ${e.message}`);
      throw e;
    }
    // An explicit `-t`/`--tabs` implies -a (GNU) — but the obsolete `-NUMBER`
    // shorthand does NOT (it sets tab stops yet still restricts to leading
    // blanks). So test the ORIGINAL argv for a real `-t`/`--tabs`, not the
    // normalized one (which rewrote `-N` into `-t N`).
    const explicitTabs = collectFlagValues(io.args.slice(1), 't', 'tabs').length > 0;
    const all = Boolean(flags.a) || explicitTabs;
    const sources = positionals.length > 0 ? positionals : ['-'];
    for (const src of sources) {
      let text: string;
      if (src === '-') text = await readAllText(io.stdin);
      else {
        try { text = new TextDecoder().decode(await readFile(io, src)); }
        catch { await writeString(err, `${name}: ${src}: No such file or directory\n`); exitCode = 1; continue; }
      }
      const hasTrailing = text.endsWith('\n');
      const body = hasTrailing ? text.slice(0, -1) : text;
      const converted = body.split('\n').map((l) => unexpandLine(l, tabs, all)).join('\n');
      await writeString(out, converted + (hasTrailing ? '\n' : ''));
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(unexpandCommand);
export { unexpandCommand, unexpandLine };

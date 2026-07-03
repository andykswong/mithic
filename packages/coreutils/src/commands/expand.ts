/**
 * `expand` — convert tabs to spaces.
 *
 * Forms:
 *   expand [-t LIST] [-i] [FILE...]
 *     -t LIST   tab stops (default 8). A single number N means every N columns;
 *               a comma/space-separated LIST gives explicit 1-based stop columns.
 *               A trailing `/N` or `+N` sets the increment used past the last
 *               explicit stop (default 1).
 *     -i        convert only leading blanks on each line (initial tabs/spaces).
 *
 * Each tab advances to the next stop past the current column. Column position
 * resets at each newline. Reads stdin when FILE is `-` or omitted.
 */
import { defineCommand, parseArgs, readAllText, writeString, exitWith, optionError } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** A parsed tab-stop specification: `nextStop(col)` → the next stop column > col. */
export interface TabStops {
  /** The single stop count when the spec is one number (else undefined). */
  single?: number;
  /** The next tab-stop column strictly greater than `col`. */
  nextStop(col: number): number;
  /**
   * Whether column `col` is exactly a tab stop. For a single-N spec every
   * multiple of N is a stop; for an explicit LIST only the listed columns are
   * (nothing beyond the last one) — this is what `unexpand` needs, since past
   * the last explicit stop there is nowhere to place a tab.
   */
  isStop(col: number): boolean;
}

/** Raised by {@link parseTabStops} with GNU's exact diagnostic (no `cmd:` prefix). */
export class TabError extends Error {}

/**
 * Parse `-t` LIST value(s) into a {@link TabStops}. Accepts a single number
 * (every-N stops), a comma/space-separated ascending list of explicit stops
 * (optionally with a trailing `/N` or `+N` extra-increment marker), or multiple
 * accumulated `-t` values. Throws {@link TabError} on 0, non-numeric, or
 * non-ascending input — matching GNU's messages.
 */
export function parseTabStops(specs: string[]): TabStops {
  const tokens: string[] = [];
  for (const spec of specs) for (const tok of spec.split(/[,\s]+/)) if (tok !== '') tokens.push(tok);
  if (tokens.length === 0) tokens.push('8');

  const stops: number[] = [];
  let extraKind: 'default' | 'slash' | 'plus' = 'default';
  let extraN = 0;
  for (let idx = 0; idx < tokens.length; idx++) {
    let tok = tokens[idx];
    let kind: 'default' | 'slash' | 'plus' = 'default';
    if (tok.startsWith('/')) { kind = 'slash'; tok = tok.slice(1); }
    else if (tok.startsWith('+')) { kind = 'plus'; tok = tok.slice(1); }
    if (!/^\d+$/.test(tok)) throw new TabError(`tab size contains invalid character(s): ‘${tok}’`);
    const n = Number(tok);
    if (n === 0) throw new TabError('tab size cannot be 0');
    if (kind !== 'default') {
      // A `/N` or `+N` marker sets the past-the-last increment; it is not itself
      // an explicit stop and must be the final token.
      extraKind = kind; extraN = n;
      continue;
    }
    if (stops.length > 0 && n <= stops[stops.length - 1]) throw new TabError('tab sizes must be ascending');
    stops.push(n);
  }
  // A lone `/N` or `+N` (no explicit stops) behaves exactly like the single-N
  // spec `-t N`: tab stops at every multiple of N.
  if (stops.length === 0 && extraKind !== 'default') { stops.push(extraN); extraKind = 'default'; }
  if (stops.length === 0) stops.push(8);

  if (stops.length === 1 && extraKind === 'default') {
    const step = stops[0];
    return {
      single: step,
      nextStop: (col) => col + (step - (col % step)),
      isStop: (col) => col > 0 && col % step === 0,
    };
  }

  const last = stops[stops.length - 1];
  return {
    nextStop(col) {
      for (const s of stops) if (s > col) return s;
      // Past the last explicit stop, advance per the trailing marker:
      //   /N → next multiple of N strictly greater than col
      //   +N → last + k·N for the smallest k giving a column > col
      //   (none) → single column (+1)
      if (extraKind === 'slash') return col + (extraN - (col % extraN));
      if (extraKind === 'plus') return last + (Math.floor((col - last) / extraN) + 1) * extraN;
      return col + 1;
    },
    isStop(col) {
      if (stops.includes(col)) return true;
      if (col <= last) return false;
      if (extraKind === 'slash') return col % extraN === 0;
      if (extraKind === 'plus') return (col - last) % extraN === 0;
      return false; // an explicit list with no marker has no stops past `last`
    },
  };
}

/** Replace tabs in `text` with spaces up to the next stop; `initialOnly` = GNU -i. */
export function expandText(text: string, tabs: TabStops, initialOnly = false): string {
  let out = '';
  let col = 0;
  let leading = true;
  for (const ch of text) {
    if (ch === '\t' && (!initialOnly || leading)) {
      const next = tabs.nextStop(col);
      out += ' '.repeat(next - col);
      col = next;
    } else if (ch === '\n') {
      out += ch;
      col = 0;
      leading = true;
    } else {
      if (ch !== ' ' && ch !== '\t') leading = false;
      out += ch;
      // A backspace moves the column back one (GNU behaviour); everything else
      // advances by one display column.
      col = ch === '\b' && col > 0 ? col - 1 : col + 1;
    }
  }
  return out;
}

/**
 * Rewrite the obsolete `-NUMBER` tab-list form into `-t NUMBER`. GNU expand and
 * unexpand accept a leading-digit option (`-4`, `-3,6`, `-4/8`) as shorthand for
 * `-t` with that list. A token is the obsolete form iff, after the `-`, it is a
 * run of digits/commas/blanks with optional trailing `/N`/`+N` markers — i.e. a
 * valid tab-list. `-t4` (real `-t`) starts with a letter, so it is untouched.
 */
export function normalizeTabArgs(argv: string[]): string[] {
  const out: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (afterDashDash) { out.push(a); continue; }
    if (a === '--') { afterDashDash = true; out.push(a); continue; }
    if (/^-[0-9]/.test(a) && /^-[0-9,/+ ]+$/.test(a)) {
      out.push('-t', a.slice(1));
      continue;
    }
    out.push(a);
  }
  return out;
}

const expandCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'expand';
  const argv = normalizeTabArgs(io.args.slice(1));
  const parsed = parseArgs(argv, {
    string: ['t', 'tabs'],
    boolean: ['i', 'initial'],
    alias: { tabs: 't', initial: 'i' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  try {
    if (parsed.unknown.length) { await writeString(err, optionError(name, parsed.unknown[0]) + '\n'); return 1; }
    // Collect every `-t`/`--tabs` value (GNU accumulates repeats).
    const tSpecs = collectFlagValues(argv, 't', 'tabs');
    let tabs: TabStops;
    try { tabs = parseTabStops(tSpecs); }
    catch (e) {
      if (e instanceof TabError) return await exitWith(err, 1, `${name}: ${e.message}`);
      throw e;
    }
    const initialOnly = Boolean(flags.i);
    const sources = positionals.length > 0 ? positionals : ['-'];
    for (const src of sources) {
      let text: string;
      if (src === '-') text = await readAllText(io.stdin);
      else {
        try { text = new TextDecoder().decode(await readFile(io, src)); }
        catch { await writeString(err, `${name}: ${src}: No such file or directory\n`); exitCode = 1; continue; }
      }
      await writeString(out, expandText(text, tabs, initialOnly));
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Gather every value passed to `-<short>` / `--<long>` across the argv (repeats accumulate). */
export function collectFlagValues(argv: string[], short: string, long: string): string[] {
  const vals: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (arg === '--') break;
    if (arg === `-${short}` || arg === `--${long}`) { const v = argv[k + 1]; if (v !== undefined) { vals.push(v); k++; } }
    else if (arg.startsWith(`--${long}=`)) vals.push(arg.slice(long.length + 3));
    else if (arg.startsWith(`-${short}`) && !arg.startsWith('--')) vals.push(arg.slice(2));
  }
  return vals;
}

export default defineCommand(expandCommand);
export { expandCommand };

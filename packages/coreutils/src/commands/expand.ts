/**
 * `expand` — convert tabs to spaces.
 *
 * Forms:
 *   expand [-t N] [FILE...]
 *     -t N   tab stops every N columns (default 8)
 *
 * Each tab advances to the next multiple of N, respecting the current column
 * (so a tab is replaced by 1–N spaces, not a fixed N). Column position resets at
 * each newline. Reads stdin when FILE is `-` or omitted.
 */
import { defineCommand, parseArgs, readAllText, writeString, exitWith } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Replace tabs in `text` with spaces to the next `tabstop` column boundary. */
export function expandText(text: string, tabstop: number): string {
  let out = '';
  let col = 0;
  for (const ch of text) {
    if (ch === '\t') {
      const next = col + (tabstop - (col % tabstop));
      out += ' '.repeat(next - col);
      col = next;
    } else if (ch === '\n') {
      out += ch;
      col = 0;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

const expandCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'expand';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['t'],
    alias: { tabs: 't' },
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
    const sources = positionals.length > 0 ? positionals : ['-'];
    for (const src of sources) {
      let text: string;
      if (src === '-') text = await readAllText(io.stdin);
      else {
        try { text = new TextDecoder().decode(await readFile(io, src)); }
        catch { await writeString(err, `${name}: ${src}: No such file or directory\n`); continue; }
      }
      await writeString(out, expandText(text, tabstop));
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(expandCommand);
export { expandCommand };

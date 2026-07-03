/**
 * `join` — join lines of two files on a common field.
 *
 * Forms:
 *   join [OPTION]... FILE1 FILE2
 *     -t CHAR   field separator for input AND output (default: runs of
 *               whitespace on input, a single space on output)
 *     -1 N      join on field N of FILE1 (default 1)
 *     -2 N      join on field N of FILE2 (default 1)
 *     -j N      join on field N of both files (shorthand for -1 N -2 N)
 *     -a N      also print unpairable lines from file N (1 or 2)
 *     -v N      print ONLY unpairable lines from file N (suppress joined output)
 *     -o LIST   output only the fields in LIST (`0`, `M.N`, or `auto`)
 *     -e STR    replace empty/absent output fields (with -o or -a) with STR
 *     -i        ignore case when comparing keys
 *     --check-order / --nocheck-order   force / disable the sort-order check
 *   Either FILE may be `-` to read stdin.
 *
 * Both inputs must be sorted on the join field (GNU's contract). This is a lazy
 * group-merge: consecutive equal-key lines form a group, matched groups fan out
 * as a cross product. Unless disabled, out-of-order input is diagnosed on stderr
 * (`FILE:LINE: is not sorted: ...`) and the exit is 1.
 */
import { defineCommand, parseArgs, optionError, exitWith, readLines, writeLine, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFileLines(io: CommandIO, path: string): Promise<string[]> {
  if (path === '-') return readLines(io.stdin);
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk); total += chunk.byteLength;
    }
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => {});
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const text = new TextDecoder().decode(buf);
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** Split a line into fields; `sep` undefined means split on whitespace runs. */
function splitFields(line: string, sep: string | undefined): string[] {
  if (sep === undefined) {
    // GNU: leading/trailing blanks are field separators; an all-blank line has
    // one empty field.
    const trimmed = line.replace(/^\s+/, '');
    return trimmed === '' ? [''] : trimmed.split(/\s+/);
  }
  return line.split(sep);
}

interface JoinRecord { key: string; fields: string[]; line: string; lineNo: number; }

/** An `-o` output spec item: the join field (`0`) or field `N` of file `1`/`2`. */
type OutSpec = { file: 0 | 1 | 2; field: number };

function parseOutputList(specs: string[]): OutSpec[] {
  const out: OutSpec[] = [];
  for (const raw of specs) {
    for (const tok of raw.split(/[,\s]+/)) {
      if (tok === '') continue;
      if (tok === '0') { out.push({ file: 0, field: 0 }); continue; }
      const m = /^([12])\.(\d+)$/.exec(tok);
      if (m) out.push({ file: Number(m[1]) as 1 | 2, field: Number(m[2]) });
    }
  }
  return out;
}

const joinCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'join';
  const parsed = parseArgs(io.args.slice(1), {
    string: ['t', '1', '2', 'j', 'a', 'v', 'o', 'e'],
    boolean: ['i', 'ignore-case', 'check-order', 'nocheck-order', 'z', 'zero-terminated', 'header'],
    alias: { 'ignore-case': 'i', 'zero-terminated': 'z' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (parsed.unknown.length) { await writeString(err, optionError(name, parsed.unknown[0]) + '\n'); return 1; }
    if (positionals.length < 2) return await exitWith(err, 1, `${name}: missing operand`);

    const sep = flags.t !== undefined ? String(flags.t) : undefined;
    const outSep = sep ?? ' ';
    const joinBoth = flags.j !== undefined ? Number(flags.j) : undefined;
    const f1 = joinBoth ?? (flags['1'] !== undefined ? Number(flags['1']) : 1);
    const f2 = joinBoth ?? (flags['2'] !== undefined ? Number(flags['2']) : 1);
    const ignoreCase = Boolean(flags.i);
    // GNU accepts repeated -a/-v (e.g. `-a1 -a2` = full outer join); parseArgs
    // keeps only the last, so scan the raw argv for every `-a N` / `-v N`.
    const collectFileArg = (letter: string): Set<string> => {
      const set = new Set<string>();
      const argv = io.args.slice(1);
      for (let k = 0; k < argv.length; k++) {
        const arg = argv[k];
        if (arg === '--') break;
        if (arg === `-${letter}`) { const v = argv[k + 1]; if (v !== undefined) { set.add(v); k++; } }
        else if (arg.startsWith(`-${letter}`) && !arg.startsWith('--')) set.add(arg.slice(2));
      }
      return set;
    };
    const aFiles = collectFileArg('a');
    const vFiles = collectFileArg('v');
    const printA1 = aFiles.has('1');
    const printA2 = aFiles.has('2');
    const onlyV1 = vFiles.has('1');
    const onlyV2 = vFiles.has('2');
    const suppressPaired = onlyV1 || onlyV2;
    const also1 = printA1 || onlyV1;
    const also2 = printA2 || onlyV2;
    const empty = flags.e !== undefined ? String(flags.e) : '';
    const outSpecsRaw = flags.o !== undefined ? [String(flags.o)] : [];
    const autoOutput = outSpecsRaw.length === 1 && outSpecsRaw[0].trim() === 'auto';
    const outSpecs = flags.o !== undefined && !autoOutput ? parseOutputList(outSpecsRaw) : null;

    let lines1: string[], lines2: string[];
    try { lines1 = await readFileLines(io, positionals[0]); }
    catch { return await exitWith(err, 1, `${name}: ${positionals[0]}: No such file or directory`); }
    try { lines2 = await readFileLines(io, positionals[1]); }
    catch { return await exitWith(err, 1, `${name}: ${positionals[1]}: No such file or directory`); }

    const cmpKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const keyOf = (fields: string[], field: number): string => {
      const k = fields[field - 1] ?? '';
      return ignoreCase ? k.toLowerCase() : k;
    };
    const toRecords = (lines: string[], field: number): JoinRecord[] =>
      lines.map((line, idx) => {
        const fields = splitFields(line, sep);
        return { key: keyOf(fields, field), fields, line, lineNo: idx + 1 };
      });
    const recs1 = toRecords(lines1, f1);
    const recs2 = toRecords(lines2, f2);

    // Fields other than the join field, in original order.
    const rest = (r: JoinRecord, joinField: number): string[] =>
      r.fields.filter((_, i) => i !== joinField - 1);

    // For `-o auto`, the field width per side is the max non-join field count.
    const autoWidth1 = autoOutput ? Math.max(0, ...recs1.map((r) => r.fields.length - 1)) : 0;
    const autoWidth2 = autoOutput ? Math.max(0, ...recs2.map((r) => r.fields.length - 1)) : 0;

    // Format one output record. `a`/`b` are the matched records (either may be
    // undefined for an unpaired side); `keyRec` supplies the printed join key.
    const emit = async (_keyRec: JoinRecord, a: JoinRecord | undefined, b: JoinRecord | undefined): Promise<void> => {
      // GNU prints the join key as it appears in file1 for a match, else from
      // whichever side is present (case preserved even under -i).
      const key = a ? (a.fields[f1 - 1] ?? '') : (b?.fields[f2 - 1] ?? '');
      if (outSpecs) {
        const parts = outSpecs.map((s) => {
          if (s.file === 0) return key;
          const rec = s.file === 1 ? a : b;
          const val = rec?.fields[s.field - 1];
          return val ?? empty;
        });
        await writeLine(out, parts.join(outSep));
        return;
      }
      if (autoOutput) {
        const parts = [key];
        const push = (rec: JoinRecord | undefined, field: number, width: number): void => {
          if (rec) for (const v of rest(rec, field)) parts.push(v);
          else for (let n = 0; n < width; n++) parts.push(empty);
        };
        push(a, f1, autoWidth1);
        push(b, f2, autoWidth2);
        await writeLine(out, parts.join(outSep));
        return;
      }
      // Default (no -o): unpaired line prints verbatim; a paired line prints
      // key + file1 rest + file2 rest.
      if (a && b) {
        await writeLine(out, [key, ...rest(a, f1), ...rest(b, f2)].join(outSep));
      } else if (a) {
        await writeLine(out, a.line);
      } else if (b) {
        await writeLine(out, b.line);
      }
    };

    // GNU's order check fires per physical line read, comparing each line to the
    // previous one from the same file. `--check-order` is fatal on the first
    // disorder; default mode only reports once an unpairable line has been seen
    // (fully-pairable unsorted input passes silently). At most once per file.
    const issuedWarning = [false, false];
    let seenUnpairable = false;
    let anyWarning = false;
    const orderNotices: string[] = [];
    let fatalDisorder = false;

    // Faithful port of GNU join()'s merge: each file is a `seq` buffer with a
    // read cursor into its record array. Lines are read strictly on demand so
    // the order check (gated on `seenUnpairable`) fires at exactly GNU's timing.
    const op = [positionals[0], positionals[1]];
    const recs = [recs1, recs2];
    const cursor = [0, 0];              // next record index to read per file
    const prevIdx: (number | null)[] = [null, null]; // last-read record index (for check_order)
    const seq: JoinRecord[][] = [[], []]; // buffered lines per file
    // Read one line into seq[w]; returns false at EOF. Runs check_order.
    const getLine = (w: 0 | 1): boolean => {
      if (cursor[w] >= recs[w].length) return false;
      const idx = cursor[w]++;
      const rec = recs[w][idx];
      const prev = prevIdx[w];
      if (prev !== null && !flags['nocheck-order'] && !issuedWarning[w]) {
        const enabled = Boolean(flags['check-order']);
        if ((enabled || seenUnpairable) && cmpKey(recs[w][prev].key, rec.key) > 0) {
          orderNotices.push(`${name}: ${op[w]}:${rec.lineNo}: is not sorted: ${rec.line}`);
          issuedWarning[w] = true;
          anyWarning = true;
          if (enabled) fatalDisorder = true;
        }
      }
      prevIdx[w] = idx;
      seq[w].push(rec);
      return true;
    };
    // advance_seq: first=true resets the buffer, then reads one line.
    const advanceSeq = (w: 0 | 1, first: boolean): boolean => {
      if (first) seq[w] = [];
      return getLine(w);
    };

    getLine(0);
    getLine(1);
    while (!fatalDisorder && seq[0].length && seq[1].length) {
      const diff = cmpKey(seq[0][0].key, seq[1][0].key);
      if (diff < 0) {
        if (also1) await emit(seq[0][0], seq[0][0], undefined);
        advanceSeq(0, true);
        seenUnpairable = true;
        continue;
      }
      if (diff > 0) {
        if (also2) await emit(seq[1][0], undefined, seq[1][0]);
        advanceSeq(1, true);
        seenUnpairable = true;
        continue;
      }
      // Equal keys: read ahead in each file while the key keeps matching. The
      // terminating (non-matching) line stays buffered as the next group seed.
      let eof1 = false;
      do {
        if (!advanceSeq(0, false)) { eof1 = true; break; }
      } while (!fatalDisorder && seq[0][seq[0].length - 1].key === seq[1][0].key);
      let eof2 = false;
      do {
        if (!advanceSeq(1, false)) { eof2 = true; break; }
      } while (!fatalDisorder && seq[0][0].key === seq[1][seq[1].length - 1].key);

      // A fatal (--check-order) disorder read during the look-ahead aborts GNU
      // immediately, before this group's pairables are printed.
      if (fatalDisorder) break;
      const n1 = eof1 ? seq[0].length : seq[0].length - 1;
      const n2 = eof2 ? seq[1].length : seq[1].length - 1;
      if (!suppressPaired) {
        for (let x = 0; x < n1; x++) for (let y = 0; y < n2; y++) await emit(seq[0][x], seq[0][x], seq[1][y]);
      }
      // Move the boundary line to the front (seed of the next group), or clear.
      seq[0] = eof1 ? [] : [seq[0][seq[0].length - 1]];
      seq[1] = eof2 ? [] : [seq[1][seq[1].length - 1]];
    }
    // Tail: whichever file still has lines is entirely unpairable now.
    while (!fatalDisorder && seq[0].length) {
      seenUnpairable = true;
      if (also1) await emit(seq[0][0], seq[0][0], undefined);
      advanceSeq(0, true);
    }
    while (!fatalDisorder && seq[1].length) {
      seenUnpairable = true;
      if (also2) await emit(seq[1][0], undefined, seq[1][0]);
      advanceSeq(1, true);
    }

    if (fatalDisorder) {
      await writeString(err, orderNotices.join('\n') + '\n');
      return 1;
    }
    if (anyWarning) {
      await writeString(err, orderNotices.join('\n') + '\n');
      await writeString(err, `${name}: input is not in sorted order\n`);
      return 1;
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(joinCommand);
export { joinCommand };

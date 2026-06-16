/**
 * `tr` — translate, squeeze, or delete characters from stdin.
 *
 * Supported:
 *   - `tr SET1 SET2`: translate chars in SET1 to the matching char in SET2.
 *   - `-d`: delete chars in SET1.
 *   - `-s`: squeeze repeats. With SET2, squeeze SET2; with `-d`, squeeze SET2;
 *     with only SET1 and no `-d`, squeeze SET1.
 *   - `-c`: complement SET1 (operate on chars NOT in SET1).
 *   - ranges `a-z`, classes `[:alpha:]`/`[:digit:]`/`[:space:]`/`[:upper:]`/`[:lower:]`.
 *
 * Reads stdin only (standard `tr`).
 */
import { defineCommand, parseArgs, readAllText, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const CLASS_MEMBERS: Record<string, () => string[]> = {
  alpha: () => [... rangeChars('a', 'z'), ...rangeChars('A', 'Z')],
  digit: () => rangeChars('0', '9'),
  alnum: () => [...rangeChars('a', 'z'), ...rangeChars('A', 'Z'), ...rangeChars('0', '9')],
  upper: () => rangeChars('A', 'Z'),
  lower: () => rangeChars('a', 'z'),
  space: () => [' ', '\t', '\n', '\r', '\v', '\f'],
  blank: () => [' ', '\t'],
  punct: () => [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
};

function rangeChars(from: string, to: string): string[] {
  const out: string[] = [];
  for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) out.push(String.fromCharCode(c));
  return out;
}

/** Expand a tr SET string into an explicit array of characters. */
export function expandSet(set: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < set.length) {
    // Character class [:name:]
    if (set[i] === '[' && set[i + 1] === ':') {
      const end = set.indexOf(':]', i + 2);
      if (end >= 0) {
        const cls = set.slice(i + 2, end);
        if (CLASS_MEMBERS[cls]) { out.push(...CLASS_MEMBERS[cls]()); i = end + 2; continue; }
      }
    }
    // Escape sequences
    if (set[i] === '\\' && i + 1 < set.length) {
      const n = set[i + 1];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', f: '\f', v: '\v' };
      out.push(map[n] ?? n);
      i += 2;
      continue;
    }
    // Range a-z
    if (set[i + 1] === '-' && i + 2 < set.length && set[i + 2] !== undefined) {
      out.push(...rangeChars(set[i], set[i + 2]));
      i += 3;
      continue;
    }
    out.push(set[i]);
    i++;
  }
  return out;
}

const trCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['d', 's', 'c', 'C', 'complement', 'delete', 'squeeze-repeats'],
    alias: { complement: 'c', C: 'c', delete: 'd', 'squeeze-repeats': 's' },
  });
  const del = Boolean(flags.d);
  const squeeze = Boolean(flags.s);
  const complement = Boolean(flags.c);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();

  try {
    if (positionals.length === 0 && !squeeze) {
      await writeString(err, `${io.args[0] ?? 'tr'}: missing operand\n`);
      return 1;
    }

    const set1 = positionals[0] !== undefined ? expandSet(positionals[0]) : [];
    const set2 = positionals[1] !== undefined ? expandSet(positionals[1]) : [];

    const text = await readAllText(io.stdin);
    const chars = [...text];

    // Membership test against set1, honoring complement.
    const set1Set = new Set(set1);
    const inSet1 = (c: string): boolean => complement ? !set1Set.has(c) : set1Set.has(c);

    let result: string[];

    if (del) {
      result = chars.filter((c) => !inSet1(c));
      if (squeeze && set2.length > 0) result = squeezeChars(result, new Set(set2));
    } else if (set2.length > 0) {
      // Translate: pad set2 to set1 length by repeating its last char (GNU behavior).
      // With complement, every non-set1 char maps to the last char of set2.
      const lastTo = set2[set2.length - 1];
      if (complement) {
        result = chars.map((c) => (inSet1(c) ? lastTo : c));
      } else {
        const map = new Map<string, string>();
        for (let k = 0; k < set1.length; k++) map.set(set1[k], set2[k] ?? lastTo);
        result = chars.map((c) => map.get(c) ?? c);
      }
      if (squeeze) result = squeezeChars(result, new Set(set2));
    } else {
      // Squeeze only (set1 is the squeeze set).
      const sqSet = complement
        ? null // squeeze chars NOT in set1 — handle via predicate below
        : new Set(set1);
      result = sqSet
        ? squeezeChars(chars, sqSet)
        : squeezeByPredicate(chars, (c) => !set1Set.has(c));
    }

    await writeString(out, result.join(''));
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
  return 0;
};

function squeezeChars(chars: string[], set: Set<string>): string[] {
  return squeezeByPredicate(chars, (c) => set.has(c));
}

function squeezeByPredicate(chars: string[], inSet: (c: string) => boolean): string[] {
  const out: string[] = [];
  let last: string | undefined;
  for (const c of chars) {
    if (inSet(c) && c === last) continue;
    out.push(c);
    last = c;
  }
  return out;
}

export default defineCommand(trCommand);
export { trCommand };

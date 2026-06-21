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
 * Reads stdin incrementally (streaming) so `yes | tr … | head` terminates.
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, writeString } from '../harness.ts';
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
  xdigit: () => [...rangeChars('0', '9'), ...rangeChars('A', 'F'), ...rangeChars('a', 'f')],
  cntrl: () => [...rangeChars('\x00', '\x1f'), '\x7f'],
  print: () => rangeChars('\x20', '\x7e'),
  graph: () => rangeChars('\x21', '\x7e'),
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
      // Octal escape `\NNN` (1-3 octal digits), e.g. `\101` → 'A', `\0` → NUL.
      if (n >= '0' && n <= '7') {
        let oct = '';
        let j = i + 1;
        while (j < set.length && j < i + 4 && set[j] >= '0' && set[j] <= '7') { oct += set[j]; j++; }
        out.push(String.fromCharCode(parseInt(oct, 8) & 0xff));
        i = j;
        continue;
      }
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', f: '\f', v: '\v', a: '\x07', b: '\b' };
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
  let stdinAborted = false;

  try {
    if (positionals.length === 0 && !squeeze) {
      await writeString(err, `${io.args[0] ?? 'tr'}: missing operand\n`);
      return 1;
    }

    const set1 = positionals[0] !== undefined ? expandSet(positionals[0]) : [];
    const set2 = positionals[1] !== undefined ? expandSet(positionals[1]) : [];

    // Membership test against set1, honoring complement.
    const set1Set = new Set(set1);
    const inSet1 = (c: string): boolean => complement ? !set1Set.has(c) : set1Set.has(c);

    // Build a per-character transform function.  Returns the output string for a
    // single input character, or '' to drop it.  The squeeze predicate (which
    // squeeze set to use) is also resolved here once, before the streaming loop.
    let translateChar: (c: string) => string;
    // null means squeeze is not active; a function means "is this char in the squeeze set?"
    let squeezeInSet: ((c: string) => boolean) | null = null;

    if (del) {
      translateChar = (c) => inSet1(c) ? '' : c;
      if (squeeze && set2.length > 0) {
        const sqSet = new Set(set2);
        squeezeInSet = (c) => sqSet.has(c);
      }
    } else if (set2.length > 0) {
      const lastTo = set2[set2.length - 1];
      if (complement) {
        translateChar = (c) => inSet1(c) ? lastTo : c;
      } else {
        const transMap = new Map<string, string>();
        for (let k = 0; k < set1.length; k++) transMap.set(set1[k], set2[k] ?? lastTo);
        translateChar = (c) => transMap.get(c) ?? c;
      }
      if (squeeze) {
        const sqSet = new Set(set2);
        squeezeInSet = (c) => sqSet.has(c);
      }
    } else {
      // Squeeze only (no SET2, no -d): translateChar is identity.
      translateChar = (c) => c;
      if (complement) {
        squeezeInSet = (c) => !set1Set.has(c);
      } else {
        const sqSet = new Set(set1);
        squeezeInSet = (c) => sqSet.has(c);
      }
    }

    // Stream stdin chunk by chunk.  tr is a per-character transform, so we
    // don't need line boundaries — we decode each chunk and process its code
    // points directly.  The `stream: true` option on TextDecoder preserves
    // multi-byte character boundaries across chunks.
    //
    // Cross-chunk squeeze state: `lastEmitted` remembers the last character
    // written so that `-s` correctly collapses runs that straddle chunk
    // boundaries (e.g. the last 'a' of one chunk and the first 'a' of the next
    // should be collapsed to one 'a').
    const sink = new CoalescingWriter(out);
    const decoder = new TextDecoder();
    let lastEmitted: string | undefined;
    const reader = io.stdin.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const text = decoder.decode(value, { stream: true });
        let buf = '';
        for (const c of text) {
          const mapped = translateChar(c);
          if (mapped === '') continue; // deleted
          if (squeezeInSet !== null && squeezeInSet(mapped) && mapped === lastEmitted) continue;
          buf += mapped;
          lastEmitted = mapped;
        }
        if (buf !== '') await sink.push(buf);
      }
      // Flush the TextDecoder's internal multi-byte tail.
      const tail = decoder.decode();
      if (tail !== '') {
        let buf = '';
        for (const c of tail) {
          const mapped = translateChar(c);
          if (mapped === '') continue;
          if (squeezeInSet !== null && squeezeInSet(mapped) && mapped === lastEmitted) continue;
          buf += mapped;
          lastEmitted = mapped;
        }
        if (buf !== '') await sink.push(buf);
      }
      await sink.flush();
    } catch (e) {
      if (isBrokenPipe(e)) { stdinAborted = true; }
      else throw e;
    } finally {
      reader.releaseLock();
    }
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
  return 0;
};

export default defineCommand(trCommand);
export { trCommand };

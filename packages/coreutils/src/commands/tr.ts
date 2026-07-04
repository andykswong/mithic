/**
 * `tr` — translate, squeeze, or delete characters from stdin.
 *
 * Supported (GNU parity):
 *   - `tr SET1 SET2`: translate chars in SET1 to the matching char in SET2.
 *   - `-d`: delete chars in SET1.
 *   - `-s`: squeeze repeats. With SET2, squeeze SET2; with `-d`, squeeze SET2;
 *     with only SET1 and no `-d`, squeeze SET1.
 *   - `-t`: truncate SET1 to the length of SET2 (else SET2 is padded).
 *   - `-c`/`-C`: complement SET1 (operate on chars NOT in SET1).
 *   - ranges `a-z`, classes `[:alpha:]` …, equivalence `[=c=]`, repeats `[c*]`/`[c*N]`.
 *   - operand-count validation matching GNU (missing/extra operand diagnostics).
 *
 * Reads stdin incrementally (streaming) so `yes | tr … | head` terminates.
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, optionError, parseArgs, writeString } from '../harness.ts';
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

/** A token in a parsed SET: a literal char run, or a `[c*N]` repeat. */
type SetToken = { kind: 'chars'; chars: string[] } | { kind: 'repeat'; char: string; count: number | null };

/** Parse a tr SET string into tokens, keeping `[c*N]` repeats unexpanded. */
export function parseSet(set: string): SetToken[] {
  const tokens: SetToken[] = [];
  const push = (chars: string[]): void => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === 'chars') last.chars.push(...chars);
    else tokens.push({ kind: 'chars', chars });
  };
  let i = 0;
  while (i < set.length) {
    // Character class [:name:]
    if (set[i] === '[' && set[i + 1] === ':') {
      const end = set.indexOf(':]', i + 2);
      if (end >= 0) {
        const cls = set.slice(i + 2, end);
        if (CLASS_MEMBERS[cls]) { push(CLASS_MEMBERS[cls]()); i = end + 2; continue; }
      }
    }
    // Equivalence class [=c=] → just the character c (no locale equivalence here).
    if (set[i] === '[' && set[i + 1] === '=') {
      const end = set.indexOf('=]', i + 2);
      if (end >= 0) { push(expandEscapes(set.slice(i + 2, end))); i = end + 2; continue; }
    }
    // Repeat [c*] / [c*N] (N decimal, or octal if it has a leading 0).
    if (set[i] === '[') {
      const close = set.indexOf(']', i + 1);
      if (close > i) {
        const inner = set.slice(i + 1, close);
        const star = inner.indexOf('*');
        if (star >= 0) {
          const charPart = expandEscapes(inner.slice(0, star));
          const countStr = inner.slice(star + 1);
          if (charPart.length === 1) {
            let count: number | null = null;
            if (countStr !== '' && countStr !== '0') {
              count = countStr[0] === '0' ? parseInt(countStr, 8) : parseInt(countStr, 10);
              if (Number.isNaN(count)) count = null;
            }
            tokens.push({ kind: 'repeat', char: charPart[0], count });
            i = close + 1;
            continue;
          }
        }
      }
    }
    // Escape sequence
    if (set[i] === '\\' && i + 1 < set.length) {
      const [ch, len] = readEscape(set, i);
      push([ch]);
      i += len;
      continue;
    }
    // Range a-z
    if (set[i + 1] === '-' && i + 2 < set.length && set[i + 2] !== undefined && set[i + 2] !== '-') {
      const from = set[i] === '\\' ? readEscape(set, i) : [set[i], 1] as [string, number];
      const afterFrom = i + from[1];
      let to: [string, number];
      if (set[afterFrom + 1] === '\\') to = readEscape(set, afterFrom + 1);
      else to = [set[afterFrom + 1], 1];
      push(rangeChars(from[0], to[0]));
      i = afterFrom + 1 + to[1];
      continue;
    }
    push([set[i]]);
    i++;
  }
  return tokens;
}

/** Read one escape sequence at `set[i]` (`\\`), returning [char, consumedLength]. */
function readEscape(set: string, i: number): [string, number] {
  const n = set[i + 1];
  if (n >= '0' && n <= '7') {
    let oct = '';
    let j = i + 1;
    while (j < set.length && j < i + 4 && set[j] >= '0' && set[j] <= '7') { oct += set[j]; j++; }
    return [String.fromCharCode(parseInt(oct, 8) & 0xff), j - i];
  }
  const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', f: '\f', v: '\v', a: '\x07', b: '\b' };
  return [map[n] ?? n, 2];
}

/** Expand only escape sequences in a short literal (repeat/equiv char). */
function expandEscapes(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) { const [ch, len] = readEscape(s, i); out.push(ch); i += len; }
    else { out.push(s[i]); i++; }
  }
  return out;
}

/**
 * Expand a SET1 string to explicit chars. SET1 `[c*]` repeats are meaningless
 * (GNU treats a `*` count as the literal count when it's SET1 but effectively a
 * repeat is only for SET2); we expand a bounded repeat and treat `[c*]` (no
 * count) as a single char.
 */
export function expandSet(set: string): string[] {
  return expandSet1(parseSet(set));
}

function expandSet1(tokens: SetToken[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'chars') out.push(...t.chars);
    else out.push(...Array(t.count ?? 1).fill(t.char));
  }
  return out;
}

/**
 * Expand SET2, resolving `[c*]`/`[c*0]` open-ended repeats to fill SET2 up to
 * `set1Len`. A `[c*N]` repeats exactly N times. Trailing open repeats also pad
 * SET2 to set1Len when translating without `-t`.
 */
function expandSet2(tokens: SetToken[], set1Len: number): string[] {
  // First expand fixed parts and mark the open repeat position.
  const out: string[] = [];
  let openAt = -1;
  let openChar = '';
  for (const t of tokens) {
    if (t.kind === 'chars') out.push(...t.chars);
    else if (t.count !== null) out.push(...Array(t.count).fill(t.char));
    else { openAt = out.length; openChar = t.char; out.push('\0PLACEHOLDER'); }
  }
  if (openAt < 0) return out;
  // Fill the open repeat so the total length reaches set1Len.
  out.splice(openAt, 1); // remove placeholder
  const need = Math.max(0, set1Len - out.length);
  out.splice(openAt, 0, ...Array(need).fill(openChar));
  return out;
}

const trCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'tr';
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['d', 's', 'c', 'C', 't', 'complement', 'delete', 'squeeze-repeats', 'truncate-set1'],
    alias: { complement: 'c', C: 'c', delete: 'd', 'squeeze-repeats': 's', 'truncate-set1': 't' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const del = Boolean(flags.d);
  const squeeze = Boolean(flags.s);
  const complement = Boolean(flags.c);
  const truncate = Boolean(flags.t);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let stdinAborted = false;

  const failMsg = async (msg: string): Promise<number> => {
    await writeString(err, msg);
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    return 1;
  };

  try {
    if (parsed.unknown.length) return failMsg(`${optionError(name, parsed.unknown[0])}\n`);
    // Operand-count validation (GNU diagnostics use U+2018/U+2019 quotes).
    const q = (s: string): string => `‘${s}’`;
    const help = `Try '${name} --help' for more information.\n`;
    const n = positionals.length;
    if (n === 0) {
      if (squeeze && !del) { /* squeeze-only with 0 operands still needs 1 */ }
      return failMsg(`${name}: missing operand\n${help}`);
    }
    if (del && squeeze) {
      if (n < 2) return failMsg(`${name}: missing operand after ${q(positionals[0])}\nTwo strings must be given when both deleting and squeezing repeats.\n${help}`);
      if (n > 2) return failMsg(`${name}: extra operand ${q(positionals[2])}\n${help}`);
    } else if (del) {
      if (n === 2) return failMsg(`${name}: extra operand ${q(positionals[1])}\nOnly one string may be given when deleting without squeezing repeats.\n${help}`);
      if (n > 2) return failMsg(`${name}: extra operand ${q(positionals[1])}\n${help}`);
    } else if (squeeze) {
      // Squeeze (no delete): 1 operand (squeeze SET1) or 2 (translate+squeeze).
      if (n > 2) return failMsg(`${name}: extra operand ${q(positionals[2])}\n${help}`);
    } else {
      // Translate: exactly 2 operands.
      if (n === 1) return failMsg(`${name}: missing operand after ${q(positionals[0])}\nTwo strings must be given when translating.\n${help}`);
      if (n > 2) return failMsg(`${name}: extra operand ${q(positionals[2])}\n${help}`);
      // An EMPTY SET2 in translate mode is an error UNLESS `-t` (truncate) is given —
      // there is nothing to translate SET1 to (GNU: "when not truncating set1, string2
      // must be non-empty", exit 1). `-t` with an empty SET2 truncates SET1 to length 0.
      // GNU emits this message WITHOUT the "Try --help" line (unlike the operand-count
      // errors above), so it is intentionally omitted here.
      if (positionals[1] === '' && !truncate) {
        return failMsg(`${name}: when not truncating set1, string2 must be non-empty\n`);
      }
    }

    const tokens1 = parseSet(positionals[0]);
    let set1 = expandSet1(tokens1);
    const tokens2 = positionals[1] !== undefined ? parseSet(positionals[1]) : [];
    const set2 = positionals[1] !== undefined ? expandSet2(tokens2, set1.length) : [];

    // `-t` truncates SET1 to the length of SET2 (translate mode only). An EMPTY SET2
    // with `-t` truncates SET1 to nothing → no character maps, so the input passes
    // through unchanged (GNU: `tr -t a-z ''` is a no-op, exit 0). Allow length 0.
    if (truncate && !del && set1.length > set2.length) {
      set1 = set1.slice(0, set2.length);
    }

    const set1Set = new Set(set1);
    const inSet1 = (c: string): boolean => complement ? !set1Set.has(c) : set1Set.has(c);

    let translateChar: (c: string) => string;
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
        // Without -t, SET2 is padded (expandSet2 already padded an open repeat;
        // otherwise repeat the last char to cover the remaining SET1 chars).
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
      if (complement) squeezeInSet = (c) => !set1Set.has(c);
      else { const sqSet = new Set(set1); squeezeInSet = (c) => sqSet.has(c); }
    }

    const sink = new CoalescingWriter(out);
    const decoder = new TextDecoder();
    let lastEmitted: string | undefined;
    const reader = io.stdin.getReader();
    const process = (text: string): string => {
      let buf = '';
      for (const c of text) {
        const mapped = translateChar(c);
        if (mapped === '') continue;
        if (squeezeInSet !== null && squeezeInSet(mapped) && mapped === lastEmitted) continue;
        buf += mapped;
        lastEmitted = mapped;
      }
      return buf;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const buf = process(decoder.decode(value, { stream: true }));
        if (buf !== '') await sink.push(buf);
      }
      const tail = process(decoder.decode());
      if (tail !== '') await sink.push(tail);
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

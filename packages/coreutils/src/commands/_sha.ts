/**
 * Shared implementation for the digest-checksum commands: `md5sum`, `sha1sum`,
 * `sha256sum`, `sha512sum`.
 *
 * Each command:
 *   Nsum [OPTION]... [FILE]...
 *     (default) print `<hex>  <name>\n` (GNU format: TWO spaces) per FILE, or
 *               `<hex>  -` reading stdin when no FILE / FILE is `-`.
 *     --tag     print in BSD reversed form: `ALGO (name) = hex`.
 *     -b/--binary  mark the name with ` *` instead of `  ` (binary mode).
 *     -z/--zero    terminate each output line with NUL instead of newline.
 *     -c/--check   treat each FILE as a checksum list; for every `<hex>  <name>`
 *               line, re-hash <name> and print `<name>: OK` / `<name>: FAILED`,
 *               with GNU's trailing `WARNING:` summaries. Exit 1 on any failure.
 *     --status  (with -c) print nothing; exit reflects success/failure.
 *     --quiet   (with -c) suppress `OK` lines (keep FAILED + warnings).
 *     --warn    (with -c) warn per improperly-formatted line.
 *     --ignore-missing (with -c) skip missing listed files silently.
 *     --strict  (with -c) exit non-zero on an improperly-formatted line.
 *
 * The `--status`/`--quiet`/`--warn`/`--ignore-missing`/`--strict` options are
 * "meaningful only when verifying checksums" — used without `-c`, GNU errors and
 * exits 1 (matched here).
 *
 * SHA digests come from Web Crypto `crypto.subtle.digest` (Node >= 26 + the
 * guest Web Worker). `md5sum` supplies a pure-TS RFC 1321 MD5 instead (Web
 * Crypto has no MD5) — see `md5sum.ts`, which calls {@link runDigestCommand}
 * with its own `digest` function.
 */
import { defineCommand, parseArgs, readAll, writeString, writeLine, optionError, exitWith } from '../harness.ts';
import { readFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

export type ShaAlgo = 'SHA-1' | 'SHA-256' | 'SHA-512';

/** Hex-encode a digest ArrayBuffer. */
function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Compute the lowercase hex digest of `bytes` under `algo`. */
export async function digestHex(algo: ShaAlgo, bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(algo, bytes as unknown as BufferSource);
  return toHex(buf);
}

async function readBytes(io: CommandIO, path: string): Promise<Uint8Array> {
  if (path === '-') return readAll(io.stdin);
  return readFile(io, path);
}

/**
 * Parse one line of a checksum file into `{ hex, name }`, or undefined. The hex
 * field must be exactly `hexLen` chars (the digest length for this algorithm) —
 * GNU rejects a wrong-length line as "improperly formatted" (so an MD5-length
 * line in a sha256sum list is malformed, and vice-versa).
 */
function parseSumLine(line: string, hexLen: number): { hex: string; name: string } | undefined {
  // GNU format: `<hex>  <name>` (two spaces); also tolerate ` *` (binary mode).
  const m = /^([0-9a-fA-F]+) [ *](.+)$/.exec(line);
  if (!m || m[1].length !== hexLen) return undefined;
  return { hex: m[1].toLowerCase(), name: m[2] };
}

/** Pluralize an English count noun: `plural(1,'checksum') === '1 checksum'`. */
function plural(n: number, singular: string, verbSingular: string, verbPlural: string): string {
  return n === 1 ? `${n} ${singular} ${verbSingular}` : `${n} ${singular}s ${verbPlural}`;
}

/** A digest function over bytes → lowercase hex (sync md5 or async subtle). */
export type Digester = (bytes: Uint8Array) => string | Promise<string>;

/**
 * The full command body shared by md5sum and the SHA family, parameterized by
 * its `digest` function. Split out so `md5sum` (pure-TS MD5) and the SHA
 * commands (Web Crypto) share flag parsing, `--tag`/`-b`/`-z` formatting, and
 * the GNU `-c` verification path (with `WARNING:` summaries) verbatim.
 */
export function runDigestCommand(cmdName: string, digest: Digester, hexLen: number): CommandFn {
  return async (io: CommandIO): Promise<number> => {
    const name = io.args[0] ?? cmdName;
    const parsed = parseArgs(io.args.slice(1), {
      boolean: ['c', 'check', 'tag', 'b', 'binary', 'z', 'zero', 'text', 't',
        'status', 'quiet', 'warn', 'w', 'ignore-missing', 'strict'],
      alias: { check: 'c', binary: 'b', zero: 'z', text: 't', warn: 'w' },
      unknown: 'error',
    });
    const out = io.stdout.getWriter();
    const err = io.stderr.getWriter();
    try {
      if (parsed.unknown.length) return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
      const flags = parsed.flags;
      const check = Boolean(flags.c);

      // The verify-only options are errors without -c.
      const meaningfulWithC: [boolean, string][] = [
        [Boolean(flags.status), '--status'],
        [Boolean(flags.quiet), '--quiet'],
        [Boolean(flags.w), '--warn'],
        [Boolean(flags['ignore-missing']), '--ignore-missing'],
        [Boolean(flags.strict), '--strict'],
      ];
      if (!check) {
        for (const [set, opt] of meaningfulWithC) {
          if (set) return await exitWith(err, 1, `${name}: the ${opt} option is meaningful only when verifying checksums\nTry '${name} --help' for more information.`);
        }
      }

      const digestHexOf = async (bytes: Uint8Array): Promise<string> => (await digest(bytes)).toLowerCase();

      if (check) {
        const status = Boolean(flags.status);
        const quiet = Boolean(flags.quiet);
        const warn = Boolean(flags.w);
        const ignoreMissing = Boolean(flags['ignore-missing']);
        const strict = Boolean(flags.strict);
        const lists = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
        let anyFailure = false;
        for (const list of lists) {
          let text: string;
          try { text = new TextDecoder().decode(await readBytes(io, list)); }
          catch { await writeLine(err, `${name}: ${list}: No such file or directory`); anyFailure = true; continue; }
          const rawLines = text.split('\n');
          if (rawLines[rawLines.length - 1] === '') rawLines.pop();
          let mismatches = 0, unreadable = 0, malformed = 0, verified = 0;
          let lineNo = 0;
          for (const line of rawLines) {
            lineNo++;
            if (line === '') continue;
            const p = parseSumLine(line, hexLen);
            if (!p) {
              malformed++;
              if (warn && !status) await writeLine(err, `${name}: ${list}: ${lineNo}: improperly formatted ${cmdName === 'md5sum' ? 'MD5' : cmdName.replace('sum', '').toUpperCase()} checksum line`);
              continue;
            }
            let actual: string;
            try { actual = await digestHexOf(await readBytes(io, p.name)); }
            catch {
              if (ignoreMissing) { continue; }
              unreadable++;
              // The `No such file` diagnostic prints even under --status (it is a
              // hard I/O error); only the `FAILED open or read` status line is gated.
              await writeLine(err, `${name}: ${p.name}: No such file or directory`);
              if (!status) await writeLine(out, `${p.name}: FAILED open or read`);
              anyFailure = true;
              continue;
            }
            verified++;
            if (actual === p.hex) { if (!status && !quiet) await writeLine(out, `${p.name}: OK`); }
            else { if (!status) await writeLine(out, `${p.name}: FAILED`); mismatches++; anyFailure = true; }
          }
          // GNU trailing diagnostics (order: no-valid-lines error, then WARNING
          // summaries). The `no properly formatted`/`no file was verified` hard
          // errors print even under --status; the WARNING summaries are suppressed.
          if (verified === 0 && unreadable === 0) {
            if (malformed > 0) { await writeLine(err, `${name}: ${list}: no properly formatted checksum lines found`); anyFailure = true; }
            else if (ignoreMissing) { await writeLine(err, `${name}: ${list}: no file was verified`); anyFailure = true; }
          }
          if (malformed > 0 && !(verified === 0 && unreadable === 0)) {
            if (!status) await writeLine(err, `${name}: WARNING: ${plural(malformed, 'line', 'is', 'are')} improperly formatted`);
            if (strict) anyFailure = true;
          }
          if (unreadable > 0 && !status) await writeLine(err, `${name}: WARNING: ${plural(unreadable, 'listed file', 'could not be read', 'could not be read')}`);
          if (mismatches > 0 && !status) await writeLine(err, `${name}: WARNING: ${plural(mismatches, 'computed checksum', 'did NOT match', 'did NOT match')}`);
        }
        return anyFailure ? 1 : 0;
      }

      // Print mode.
      const tag = Boolean(flags.tag);
      const binary = Boolean(flags.b);
      const zero = Boolean(flags.z);
      const term = zero ? '\0' : '\n';
      const sources = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
      let code = 0;
      const tagLabel = cmdName === 'md5sum' ? 'MD5' : cmdName.replace('sum', '').toUpperCase();
      for (const src of sources) {
        let hex: string;
        try { hex = await digestHexOf(await readBytes(io, src)); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); code = 1; continue; }
        const shown = src === '-' ? '-' : src;
        if (tag) await writeString(out, `${tagLabel} (${shown}) = ${hex}${term}`);
        else await writeString(out, `${hex} ${binary ? '*' : ' '}${shown}${term}`);
      }
      return code;
    } finally {
      await out.close().catch(() => {});
      await err.close().catch(() => {});
    }
  };
}

/** Hex digest length (chars) for each SHA algorithm. */
const SHA_HEXLEN: Record<ShaAlgo, number> = { 'SHA-1': 40, 'SHA-256': 64, 'SHA-512': 128 };

/** Build a `CommandFn` for one SHA algorithm. */
export function makeShaCommand(cmdName: string, algo: ShaAlgo): CommandFn {
  return runDigestCommand(cmdName, (bytes) => digestHex(algo, bytes), SHA_HEXLEN[algo]);
}

/** Convenience: wrap a SHA `CommandFn` as a guest default export. */
export function defineShaCommand(cmdName: string, algo: ShaAlgo): (boot: unknown) => Promise<void> {
  return defineCommand(makeShaCommand(cmdName, algo));
}

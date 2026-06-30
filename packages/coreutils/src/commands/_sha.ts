/**
 * Shared implementation for the SHA-family checksum commands: `sha1sum`,
 * `sha256sum`, `sha512sum`.
 *
 * Each command:
 *   shaNsum [-c] [FILE...]
 *     (default) print `<hex>  <name>\n` (GNU format: TWO spaces) for each FILE,
 *               or `<hex>  -` reading stdin when no FILE / FILE is `-`.
 *     -c        treat each FILE as a checksum list; for every `<hex>  <name>`
 *               line, re-hash <name> and print `<name>: OK` / `<name>: FAILED`.
 *               Exit 1 if any line fails (or a listed file can't be read).
 *
 * Digests come from Web Crypto `crypto.subtle.digest`, which is available in
 * both Node (>= 26) and the guest Web Worker — NO WebAssembly and no
 * dependencies.
 *
 * `md5sum` is a sibling command but does NOT live here: Web Crypto exposes no
 * MD5, so it uses a hand-rolled pure-TS RFC 1321 MD5 (`_md5.ts`) instead of
 * `crypto.subtle.digest`. See `md5sum.ts` (it mirrors this file's
 * `[-c]`/format/stdin scaffolding).
 */
import { defineCommand, parseArgs, readAll, writeString, writeLine } from '../harness.ts';
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

/** Parse one line of a checksum file into `{ hex, name }`, or undefined. */
function parseSumLine(line: string): { hex: string; name: string } | undefined {
  // GNU format: `<hex>  <name>` (two spaces); also tolerate ` *` (binary mode).
  const m = /^([0-9a-fA-F]+) [ *](.+)$/.exec(line);
  if (!m) return undefined;
  return { hex: m[1].toLowerCase(), name: m[2] };
}

/** Build a `CommandFn` for one SHA algorithm. */
export function makeShaCommand(cmdName: string, algo: ShaAlgo): CommandFn {
  return async (io: CommandIO): Promise<number> => {
    const name = io.args[0] ?? cmdName;
    const { positionals, flags } = parseArgs(io.args.slice(1), {
      boolean: ['c'],
      alias: { check: 'c' },
    });
    const out = io.stdout.getWriter();
    const err = io.stderr.getWriter();
    try {
      if (flags.c) {
        const lists = positionals.length > 0 ? positionals : ['-'];
        let failed = false;
        for (const list of lists) {
          let text: string;
          try { text = new TextDecoder().decode(await readBytes(io, list)); }
          catch { await writeLine(err, `${name}: ${list}: No such file or directory`); failed = true; continue; }
          const lines = text.split('\n').filter((l) => l !== '');
          for (const line of lines) {
            const parsed = parseSumLine(line);
            if (!parsed) { await writeLine(err, `${name}: ${list}: improperly formatted checksum line`); failed = true; continue; }
            let actual: string;
            try { actual = await digestHex(algo, await readBytes(io, parsed.name)); }
            catch { await writeLine(out, `${parsed.name}: FAILED open or read`); failed = true; continue; }
            if (actual === parsed.hex) await writeLine(out, `${parsed.name}: OK`);
            else { await writeLine(out, `${parsed.name}: FAILED`); failed = true; }
          }
        }
        return failed ? 1 : 0;
      }

      const sources = positionals.length > 0 ? positionals : ['-'];
      let code = 0;
      for (const src of sources) {
        let hex: string;
        try { hex = await digestHex(algo, await readBytes(io, src)); }
        catch { await writeLine(err, `${name}: ${src}: No such file or directory`); code = 1; continue; }
        await writeString(out, `${hex}  ${src === '-' ? '-' : src}\n`);
      }
      return code;
    } finally {
      await out.close().catch(() => {});
      await err.close().catch(() => {});
    }
  };
}

/** Convenience: wrap a SHA `CommandFn` as a guest default export. */
export function defineShaCommand(cmdName: string, algo: ShaAlgo): (boot: unknown) => Promise<void> {
  return defineCommand(makeShaCommand(cmdName, algo));
}

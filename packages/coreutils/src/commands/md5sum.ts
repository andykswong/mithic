/**
 * `md5sum` — print or check MD5 checksums.
 *
 *   md5sum [-c] [FILE...]
 *     (default) print `<hex>  <name>\n` (GNU format: TWO spaces) for each FILE,
 *               or `<hex>  -` reading stdin when no FILE / FILE is `-`.
 *     -c        treat each FILE as a checksum list; for every `<hex>  <name>`
 *               line, re-hash <name> and print `<name>: OK` / `<name>: FAILED`.
 *               Exit 1 if any line fails (or a listed file can't be read).
 *
 * The digest comes from a pure-TS RFC 1321 MD5 (`_md5.ts`) — Web Crypto exposes
 * no MD5, so unlike the SHA family this cannot use `crypto.subtle.digest`. The
 * `[-c]`/format/stdin scaffolding mirrors `_sha.ts` exactly.
 */
import { defineCommand, parseArgs, readAll, writeString, writeLine } from '../harness.ts';
import { readFile } from '../fs.ts';
import { md5hex } from './_md5.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

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

const md5sumCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'md5sum';
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
          try { actual = md5hex(await readBytes(io, parsed.name)); }
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
      try { hex = md5hex(await readBytes(io, src)); }
      catch { await writeLine(err, `${name}: ${src}: No such file or directory`); code = 1; continue; }
      await writeString(out, `${hex}  ${src === '-' ? '-' : src}\n`);
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(md5sumCommand);
export { md5sumCommand };

/**
 * `echo` — write arguments to stdout.
 *
 * Flags:
 *   -n   do not output the trailing newline
 *   -e   enable interpretation of backslash escape sequences
 *   -E   disable escape interpretation (default; cancels -e)
 *
 * Supported escapes with -e: \\ \a \b \f \n \r \t \v \0NNN \xHH
 */
import { defineCommand, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/**
 * Interpret backslash escapes the way `echo -e` / `printf %b` do, returning the
 * decoded text and whether a `\c` escape was hit (which suppresses everything
 * from that point on — including the trailing newline for `echo -e`).
 *
 * Octal handling matches GNU: after `\`, up to 3 octal digits form the byte
 * value, with an optional leading `0` (`\101` and `\0101`→`\010`+`1` both work —
 * the leading `0` counts as one of the (up to) three digits when present as the
 * first, i.e. we read at most 3 octal digits total after the backslash).
 */
export function processEscapesFull(s: string): { text: string; truncated: boolean } {
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      switch (next) {
        case '\\': result += '\\'; i += 2; break;
        case 'a': result += '\x07'; i += 2; break;
        case 'b': result += '\b'; i += 2; break;
        case 'c': return { text: result, truncated: true };
        case 'e': result += '\x1b'; i += 2; break;
        case 'f': result += '\f'; i += 2; break;
        case 'n': result += '\n'; i += 2; break;
        case 'r': result += '\r'; i += 2; break;
        case 't': result += '\t'; i += 2; break;
        case 'v': result += '\v'; i += 2; break;
        case '0': case '1': case '2': case '3':
        case '4': case '5': case '6': case '7': {
          // echo -e / printf %b octal: an OPTIONAL leading `0`, then up to 3
          // octal digits. `\101`→A, `\0101`→A, `\1234`→'S'+'4', `\01234`→'S'+'4'.
          let j = i + 1;
          if (s[j] === '0') j++; // consume the optional leading zero
          const start = j;
          let oct = '';
          while (j < s.length && j < start + 3 && s[j] >= '0' && s[j] <= '7') {
            oct += s[j++];
          }
          result += String.fromCharCode(parseInt(oct || '0', 8) & 0xff);
          i = j;
          break;
        }
        case 'x': {
          // \xHH — hex (up to 2 digits)
          const hex = s.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/)?.[0];
          if (hex) {
            result += String.fromCharCode(parseInt(hex, 16));
            i += 2 + hex.length;
          } else {
            result += '\\x'; i += 2;
          }
          break;
        }
        default: result += '\\' + next; i += 2; break;
      }
    } else {
      result += s[i++];
    }
  }
  return { text: result, truncated: false };
}

/** Interpret backslash escapes (see {@link processEscapesFull}); text only. */
export function processEscapes(s: string): string {
  return processEscapesFull(s).text;
}

const echoCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const rawArgs = io.args.slice(1);

  // Parse flags manually (echo has unusual flag semantics: -e/-n/-E can be
  // combined like -en, but anything not purely flags is a literal argument).
  let noNewline = false;
  let escapes = false;
  let i = 0;
  for (; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (/^-[neE]+$/.test(arg)) {
      if (arg.includes('n')) noNewline = true;
      if (arg.includes('e')) escapes = true;
      if (arg.includes('E')) escapes = false;
    } else {
      break;
    }
  }

  const parts = rawArgs.slice(i);
  let output = parts.join(' ');
  if (escapes) {
    const { text, truncated } = processEscapesFull(output);
    output = text;
    // A `\c` escape suppresses the rest of the output AND the trailing newline.
    if (truncated) noNewline = true;
  }
  if (!noNewline) output += '\n';

  const out = io.stdout.getWriter();
  try {
    await writeString(out, output);
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(echoCommand);
export { echoCommand };

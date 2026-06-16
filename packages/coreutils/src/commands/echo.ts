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

export function processEscapes(s: string): string {
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      switch (next) {
        case '\\': result += '\\'; i += 2; break;
        case 'a': result += '\x07'; i += 2; break;
        case 'b': result += '\b'; i += 2; break;
        case 'f': result += '\f'; i += 2; break;
        case 'n': result += '\n'; i += 2; break;
        case 'r': result += '\r'; i += 2; break;
        case 't': result += '\t'; i += 2; break;
        case 'v': result += '\v'; i += 2; break;
        case '0': {
          // \0NNN — octal (up to 3 digits after the 0)
          let oct = '';
          let j = i + 2;
          while (j < s.length && j < i + 5 && s[j] >= '0' && s[j] <= '7') {
            oct += s[j++];
          }
          result += String.fromCharCode(parseInt(oct || '0', 8));
          i = j;
          break;
        }
        case 'x': {
          // \xHH — hex (2 digits)
          const hex = s.slice(i + 2, i + 4);
          if (/^[0-9a-fA-F]{1,2}$/.test(hex)) {
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
  return result;
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
  if (escapes) output = processEscapes(output);
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

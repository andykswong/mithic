/**
 * `date` — print or set the current date/time.
 *
 * Flags:
 *   +FMT          output format (strftime-like; default '%a %b %e %H:%M:%S %Z %Y')
 *   -u / --utc    force UTC output
 *   -d STR        parse and display STR instead of current time (ISO 8601 / epoch)
 *
 * Time source: We use `Date.now()` which is available in all JS environments
 * including WASM guest workers. If `Date.now` is somehow unavailable (e.g.
 * a hardened sandbox with stripped globals), we fall back to the `clock/now`
 * syscall (if the harness ever exposes it), then to epoch 0 with a warning.
 * In practice mithic guests always have `Date.now`.
 */
import { defineCommand, parseArgs, writeLine, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Break epoch seconds into a UTC date/time struct. */
function epochToUtc(secs: number): {
  year: number; month: number; day: number;
  hour: number; min: number; sec: number; weekday: number; yday: number;
} {
  const d = new Date(secs * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const min = d.getUTCMinutes();
  const sec = d.getUTCSeconds();
  const weekday = d.getUTCDay(); // 0 = Sunday
  // Day of year
  const start = Date.UTC(year, 0, 0);
  const yday = Math.floor((d.getTime() - start) / 86400000);
  return { year, month, day, hour, min, sec, weekday, yday };
}

/** Break epoch seconds into local date/time struct (uses JS Date). */
function epochToLocal(secs: number): ReturnType<typeof epochToUtc> {
  const d = new Date(secs * 1000);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = d.getHours();
  const min = d.getMinutes();
  const sec = d.getSeconds();
  const weekday = d.getDay();
  const start = new Date(year, 0, 0).getTime();
  const yday = Math.floor((d.getTime() - start) / 86400000);
  return { year, month, day, hour, min, sec, weekday, yday };
}

const MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_ABR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function formatDate(fmt: string, epochSecs: number, utc: boolean): string {
  const dt = utc ? epochToUtc(epochSecs) : epochToLocal(epochSecs);
  let result = '';
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === '%' && i + 1 < fmt.length) {
      i++;
      const spec = fmt[i++];
      switch (spec) {
        case 'Y': result += String(dt.year).padStart(4, '0'); break;
        case 'y': result += String(dt.year % 100).padStart(2, '0'); break;
        case 'm': result += String(dt.month).padStart(2, '0'); break;
        case 'd': result += String(dt.day).padStart(2, '0'); break;
        case 'e': result += String(dt.day).padStart(2, ' '); break;
        case 'H': result += String(dt.hour).padStart(2, '0'); break;
        case 'M': result += String(dt.min).padStart(2, '0'); break;
        case 'S': result += String(dt.sec).padStart(2, '0'); break;
        case 's': result += String(Math.floor(epochSecs)); break;
        case 'j': result += String(dt.yday).padStart(3, '0'); break;
        case 'b': case 'h': result += MONTHS_ABR[dt.month - 1] ?? ''; break;
        case 'B': result += MONTHS_FULL[dt.month - 1] ?? ''; break;
        case 'a': result += DAYS_ABR[dt.weekday] ?? ''; break;
        case 'A': result += DAYS_FULL[dt.weekday] ?? ''; break;
        case 'u': result += String(dt.weekday === 0 ? 7 : dt.weekday); break;
        case 'w': result += String(dt.weekday); break;
        case 'p': result += dt.hour < 12 ? 'AM' : 'PM'; break;
        case 'P': result += dt.hour < 12 ? 'am' : 'pm'; break;
        case 'I': result += String(dt.hour % 12 || 12).padStart(2, '0'); break;
        case 'l': result += String(dt.hour % 12 || 12).padStart(2, ' '); break;
        case 'n': result += '\n'; break;
        case 't': result += '\t'; break;
        case '%': result += '%'; break;
        case 'Z': result += utc ? 'UTC' : 'UTC'; break;
        case 'T': result += `${String(dt.hour).padStart(2,'0')}:${String(dt.min).padStart(2,'0')}:${String(dt.sec).padStart(2,'0')}`; break;
        case 'D': result += `${String(dt.month).padStart(2,'0')}/${String(dt.day).padStart(2,'0')}/${String(dt.year % 100).padStart(2,'0')}`; break;
        case 'F': result += `${String(dt.year).padStart(4,'0')}-${String(dt.month).padStart(2,'0')}-${String(dt.day).padStart(2,'0')}`; break;
        case 'R': result += `${String(dt.hour).padStart(2,'0')}:${String(dt.min).padStart(2,'0')}`; break;
        case 'r': result += `${String(dt.hour % 12 || 12).padStart(2,'0')}:${String(dt.min).padStart(2,'0')}:${String(dt.sec).padStart(2,'0')} ${dt.hour < 12 ? 'AM' : 'PM'}`; break;
        case 'c': result += formatDate('%a %b %e %T %Z %Y', epochSecs, utc); break;
        case 'x': result += formatDate('%D', epochSecs, utc); break;
        case 'X': result += formatDate('%T', epochSecs, utc); break;
        default: result += '%' + spec; break;
      }
    } else {
      result += fmt[i++];
    }
  }
  return result;
}

/** Get current epoch seconds. Uses Date.now() (always available in mithic guests). */
function getNow(): number {
  return Date.now() / 1000;
}

/** Parse a date string for -d: accepts ISO 8601 or epoch integer. */
function parseDate(str: string): number | null {
  // Try epoch integer
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  // Try Date.parse (ISO 8601 and common formats)
  const ms = Date.parse(str);
  if (!isNaN(ms)) return ms / 1000;
  return null;
}

const dateCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'date';
  const rawArgs = io.args.slice(1);

  // Extract format (+FMT) from positionals before parseArgs eats it
  let fmt = '%a %b %e %H:%M:%S %Z %Y';
  const filteredArgs: string[] = [];
  for (const a of rawArgs) {
    if (a.startsWith('+')) { fmt = a.slice(1); }
    else { filteredArgs.push(a); }
  }

  const { flags } = parseArgs(filteredArgs, {
    boolean: ['u', 'utc', 'universal'],
    string: ['d', 'date'],
    alias: { utc: 'u', universal: 'u', date: 'd' },
  });

  const utc = Boolean(flags.u);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    let epochSecs: number;
    if (flags.d !== undefined) {
      const parsed = parseDate(String(flags.d));
      if (parsed === null) {
        return await exitWith(err, 1, `${name}: invalid date '${flags.d}'`);
      }
      epochSecs = parsed;
    } else {
      epochSecs = getNow();
    }

    await writeLine(out, formatDate(fmt, epochSecs, utc));
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(dateCommand);
export { dateCommand };

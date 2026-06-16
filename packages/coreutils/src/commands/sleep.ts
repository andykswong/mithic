/**
 * `sleep` — suspend execution for a time interval.
 *
 * Usage: sleep NUMBER[SUFFIX]
 *   SUFFIX: s (seconds, default), m (minutes), h (hours)
 *
 * Time source: We use `setTimeout` wrapped in a Promise. The guest runtime
 * provides a JS event-loop environment in which `setTimeout` is available both
 * in the browser and in Node.js >= 26. There is no WASI clock syscall plumbed
 * through the harness, so `setTimeout` is the correct mechanism here.
 *
 * Limitation: resolution is ~1 ms (standard JS timer granularity). Sub-ms
 * intervals are treated as 0 (no sleep). This matches GNU sleep behaviour on
 * most systems where the OS timer granularity is also ~1 ms.
 */
import { defineCommand, parseArgs, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Parse a sleep argument like "1.5", "2m", "3h". Returns milliseconds. */
export function parseSleepArg(arg: string): number | null {
  const m = /^([0-9]*\.?[0-9]+)(s|m|h)?$/.exec(arg);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2] ?? 's';
  if (unit === 's') return val * 1000;
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'h') return val * 3600 * 1000;
  return null;
}

const sleepCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'sleep';
  const { positionals } = parseArgs(io.args.slice(1), {});

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (positionals.length !== 1) {
      return await exitWith(err, 1, `${name}: missing operand`);
    }
    const ms = parseSleepArg(positionals[0]);
    if (ms === null || ms < 0) {
      return await exitWith(err, 1, `${name}: invalid time interval '${positionals[0]}'`);
    }
    if (ms > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, ms));
    }
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(sleepCommand);
export { sleepCommand };

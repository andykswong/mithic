/**
 * `printenv` — print all or part of the environment.
 *
 * Forms:
 *   printenv              print every variable as `KEY=VALUE\n`, sorted by key
 *   printenv VAR...       print each named variable's value (one per line);
 *                         exit 1 if any named variable is unset (matching GNU:
 *                         found values are still printed before the failure)
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const printenvCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals } = parseArgs(io.args.slice(1), {});
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (positionals.length === 0) {
      for (const [k, v] of Object.entries(io.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        await writeLine(out, `${k}=${v}`);
      }
      return 0;
    }
    let code = 0;
    for (const name of positionals) {
      const value = io.env[name];
      if (value === undefined) code = 1;
      else await writeLine(out, value);
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(printenvCommand);
export { printenvCommand };

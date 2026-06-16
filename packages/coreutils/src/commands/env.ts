/**
 * `env` — run a program in a modified environment, or print the environment.
 *
 * Usage:
 *   env                        print all environment variables
 *   env VAR=val ... CMD [args] run CMD with modified environment
 *   env -u VAR CMD [args]      run CMD with VAR removed
 *   env -i CMD [args]          run CMD with empty environment (not supported
 *                               in sandboxed guests; prints warning)
 *
 * In the mithic sandbox, `env` cannot exec a new process — it can only print
 * the environment or report what the modified environment would be.
 * When operands include a COMMAND, we output the modified env and exit 0 with
 * a note, since process spawning is the kernel's responsibility, not ours.
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const envCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['i', 'ignore-environment'],
    string: ['u', 'unset'],
    alias: { 'ignore-environment': 'i', unset: 'u' },
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    // Build modified environment
    const env: Record<string, string> = flags.i ? {} : { ...io.env };
    if (flags.u) {
      delete env[String(flags.u)];
    }

    // Consume VAR=val assignments from positionals
    let cmdStart = 0;
    for (let i = 0; i < positionals.length; i++) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(positionals[i])) {
        const eq = positionals[i].indexOf('=');
        env[positionals[i].slice(0, eq)] = positionals[i].slice(eq + 1);
        cmdStart = i + 1;
      } else {
        cmdStart = i;
        break;
      }
    }

    // If there's a command name remaining, we can't exec it — just print the
    // modified env. The shell is responsible for actual exec.
    for (const [k, v] of Object.entries(env).sort()) {
      await writeLine(out, `${k}=${v}`);
    }

    // If a command was specified, report it to stderr (we can't exec)
    if (cmdStart < positionals.length) {
      await writeLine(err, `${io.args[0] ?? 'env'}: exec not supported in sandboxed guest; printed modified environment`);
    }

    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(envCommand);
export { envCommand };

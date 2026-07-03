/**
 * `env` — run a program in a modified environment, or print the environment.
 *
 * Usage:
 *   env                        print all environment variables
 *   env VAR=val ... CMD [args] run CMD with modified environment
 *   env -u VAR CMD [args]      run CMD with VAR removed
 *   env -i CMD [args]          run CMD with an empty environment
 *
 * When a COMMAND operand is present, `env` execs it via the `process/pipeline`
 * syscall (like `xargs`/`find -exec`), passing the modified environment as the
 * stage's `env`, forwarding the child's stdout to our own, and returning the
 * child's exit code. The caller must grant `env` the `process` capability.
 * A command that cannot be resolved yields GNU's `No such file or directory`
 * diagnostic and exit 127.
 *
 * With no COMMAND, `env` prints the modified environment (one `NAME=value` per
 * line) and exits 0.
 */
import { defineCommand, parseArgs, writeLine, writeBytes, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const envCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'env';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['i', 'ignore-environment'],
    string: ['u', 'unset'],
    alias: { 'ignore-environment': 'i', unset: 'u' },
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    // Build modified environment.
    const env: Record<string, string> = flags.i ? {} : { ...io.env };
    if (flags.u) {
      delete env[String(flags.u)];
    }

    // Consume leading VAR=val assignments; the first non-assignment operand
    // begins the COMMAND (and its args).
    let cmdStart = positionals.length;
    for (let i = 0; i < positionals.length; i++) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(positionals[i])) {
        const eq = positionals[i].indexOf('=');
        env[positionals[i].slice(0, eq)] = positionals[i].slice(eq + 1);
      } else {
        cmdStart = i;
        break;
      }
    }

    // No COMMAND: print the modified environment and exit.
    if (cmdStart >= positionals.length) {
      for (const [k, v] of Object.entries(env)) {
        await writeLine(out, `${k}=${v}`);
      }
      return 0;
    }

    // COMMAND present: exec it with the modified environment via process/pipeline
    // (a single stage whose stdout we capture and forward). This is the same
    // mechanism xargs/find use; the caller must hold the `process` capability.
    const argv = positionals.slice(cmdStart);
    try {
      const result = await io.syscall('process/pipeline', {
        stages: [{ path: argv[0], argv, env }],
      }) as { exitCodes: number[]; stdout: Uint8Array };
      if (result.stdout && result.stdout.byteLength > 0) {
        await writeBytes(out, result.stdout);
      }
      return result.exitCodes[0] ?? 0;
    } catch (e) {
      // ENOENT from the pipeline (command not resolvable) → GNU: exit 127.
      // Other errors (e.g. EPERM: missing process cap) → exit 126.
      const code = (e as { code?: string })?.code;
      if (code === 'ENOENT') {
        return await exitWith(err, 127, `${name}: ‘${argv[0]}’: No such file or directory`);
      }
      return await exitWith(err, 126, `${name}: ‘${argv[0]}’: ${(e as Error).message}`);
    }
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(envCommand);
export { envCommand };

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
import { defineCommand, writeLine, writeBytes, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const envCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'env';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    // Manually parse options so we can (a) collect multiple `-u NAME`/`--unset
    // NAME` (env allows repeats), (b) detect a missing option-argument — which
    // parseArgs would silently coerce to an empty string — and (c) reject unknown
    // options. GNU env exits 125 with a getopt-style diagnostic. Options stop at
    // the first non-option operand (a VAR=val assignment or the COMMAND).
    const raw = io.args.slice(1);
    const unsets: string[] = [];
    let ignoreEnv = false;
    let k = 0;
    let optErr: string | undefined;
    outer: for (; k < raw.length; k++) {
      const a = raw[k];
      if (a === '--') { k++; break; }
      if (a === '-' || !a.startsWith('-')) break;
      if (a.startsWith('--')) {
        const body = a.slice(2);
        const eq = body.indexOf('=');
        const longName = eq >= 0 ? body.slice(0, eq) : body;
        if (longName === 'ignore-environment') { ignoreEnv = true; continue; }
        if (longName === 'unset') {
          if (eq >= 0) { unsets.push(body.slice(eq + 1)); continue; }
          const val = raw[k + 1];
          if (val === undefined) {
            optErr = `${name}: option '--unset' requires an argument`;
            break outer;
          }
          unsets.push(val); k++; continue;
        }
        optErr = `${name}: unrecognized option '--${longName}'`;
        break outer;
      }
      // Short-flag cluster: -i, -u NAME, -uNAME, -iu NAME.
      const cluster = a.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const ch = cluster[j];
        if (ch === 'i') { ignoreEnv = true; continue; }
        if (ch === 'u') {
          const attached = cluster.slice(j + 1);
          if (attached.length > 0) { unsets.push(attached); break; }
          const val = raw[k + 1];
          if (val === undefined) {
            optErr = `${name}: option requires an argument -- 'u'`;
            break outer;
          }
          unsets.push(val); k++; break;
        }
        optErr = `${name}: invalid option -- '${ch}'`;
        break outer;
      }
    }
    if (optErr !== undefined) {
      return await exitWith(err, 125, `${optErr}\nTry '${name} --help' for more information.`);
    }
    const positionals = raw.slice(k);

    // A `-u NAME` where NAME is empty or contains `=` is not a valid variable
    // name to unset — GNU: `cannot unset ‘NAME’: Invalid argument`, exit 125.
    for (const u of unsets) {
      if (u === '' || u.includes('=')) {
        return await exitWith(err, 125, `${name}: cannot unset ‘${u}’: Invalid argument`);
      }
    }

    // Build modified environment.
    const env: Record<string, string> = ignoreEnv ? {} : { ...io.env };
    for (const u of unsets) delete env[u];

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

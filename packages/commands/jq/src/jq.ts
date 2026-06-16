/**
 * `jq` — the guest entry point: a sandboxed Mithic process that reads JSON from
 * stdin (or runs with `null` input under `-n`), applies a jq filter program,
 * and writes results to stdout.
 *
 * This file is the delivery module: the repo's `preserveModules` vite build
 * emits it 1:1 as `dist/jq.js`, which {@link import('./resolver.ts').resolveJq}
 * hands to the kernel by URL. `createGuest` (inside {@link defineCommand}) wires
 * stdio; all jq language work is done by the pure engine in {@link import('./engine.ts')}.
 *
 * Flags: `-r -c -n -s -R -e -j -a -S --tab --indent N --arg --argjson`.
 */
import { defineCommand, readAllText, writeString } from './harness.ts';
import type { CommandFn, CommandIO } from './harness.ts';
import { compile, JQError } from './engine.ts';
import { formatOutput, parseInputs, parseJqArgs } from './cli.ts';

const jqCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const opts = parseJqArgs(io.args.slice(1));

  let filter;
  try {
    filter = compile(opts.program);
  } catch (e) {
    const w = io.stderr.getWriter();
    await writeString(w, `jq: error: ${(e as Error).message}\n`);
    await w.close().catch(() => { /* */ });
    return 3;
  }

  // Gather inputs. `-n` runs once with `null` input but still allows the filter
  // to pull from `inputs` later (not supported here); plain mode reads stdin.
  let inputs: unknown[];
  if (opts.nullInput) {
    inputs = [null];
  } else {
    const text = await readAllText(io.stdin);
    inputs = parseInputs(text, opts);
  }

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const sep = opts.join ? '' : '\n';
  let exitCode = 0;
  let lastOutput: unknown = undefined;
  let produced = false;

  try {
    for (const input of inputs) {
      try {
        for (const value of filter.run(input, { env: io.env, args: opts.args })) {
          produced = true;
          lastOutput = value;
          await writeString(out, formatOutput(value, opts) + sep);
        }
      } catch (e) {
        if (e instanceof JQError) {
          const v = (e as JQError).value;
          // halt_error: bubble the requested exit code.
          if (v && typeof v === 'object' && (v as { __halt?: boolean }).__halt) {
            const h = v as { code: number; value?: unknown };
            if (h.value !== undefined) await writeString(err, typeof h.value === 'string' ? h.value : JSON.stringify(h.value) + '\n');
            await out.close().catch(() => { /* */ });
            await err.close().catch(() => { /* */ });
            return h.code;
          }
          await writeString(err, `jq: error: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
          exitCode = 5;
        } else {
          throw e;
        }
      }
    }
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }

  // -e: exit status reflects the last output value (false/null/no-output → non-zero).
  if (opts.exitStatus && exitCode === 0) {
    if (!produced) return 4;
    if (lastOutput === null || lastOutput === false) return 1;
  }
  return exitCode;
};

export default defineCommand(jqCommand);

// Exported for direct unit testing of the command logic without a kernel.
export { jqCommand };

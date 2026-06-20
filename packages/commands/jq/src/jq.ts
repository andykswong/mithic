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
import { compile, HaltError, JQError } from './engine.ts';
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

  // Read the whole input stream up front, then drive it through a single shared
  // iterator so the `input`/`inputs` builtins consume from the *same* stream the
  // main loop walks (matching jq). `-n` runs the program once with `null` for the
  // initial input, but the stdin stream is still parsed so `input`/`inputs` can
  // pull from it.
  const streamValues = parseInputs(await readAllText(io.stdin), opts);
  const stream: Iterator<unknown> = streamValues[Symbol.iterator]();

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const sep = opts.join ? '' : '\n';
  let exitCode = 0;
  let lastOutput: unknown = undefined;
  let produced = false;
  // Collect debug lines and flush them as we go (jq writes them to stderr).
  const pendingDebug: string[] = [];
  const runOpts = {
    env: io.env,
    args: opts.args,
    inputs: stream,
    debug: (msg: unknown) => { pendingDebug.push(JSON.stringify(msg)); },
  };
  const flushDebug = async (): Promise<void> => {
    while (pendingDebug.length) await writeString(err, pendingDebug.shift()! + '\n');
  };

  // Drive the main loop: under `-n` run once with null; otherwise once per
  // top-level input pulled from the shared stream.
  const mainInputs = (function* (): Generator<unknown> {
    if (opts.nullInput) { yield null; return; }
    for (;;) { const n = stream.next(); if (n.done) return; yield n.value; }
  })();

  try {
    for (const input of mainInputs) {
      try {
        for (const value of filter.run(input, runOpts)) {
          produced = true;
          lastOutput = value;
          await flushDebug();
          await writeString(out, formatOutput(value, opts) + sep);
        }
        await flushDebug();
      } catch (e) {
        await flushDebug();
        // halt / halt_error: unwind the whole program with the requested code.
        if (e instanceof HaltError) {
          const h = e;
          if (h.value !== undefined && h.value !== null) {
            await writeString(err, typeof h.value === 'string' ? h.value : JSON.stringify(h.value) + '\n');
          }
          await out.close().catch(() => { /* */ });
          await err.close().catch(() => { /* */ });
          return h.code;
        }
        if (e instanceof JQError) {
          const v = (e as JQError).value;
          await writeString(err, `jq: error: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
          exitCode = 5;
        } else {
          throw e;
        }
      }
    }
  } finally {
    await flushDebug();
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

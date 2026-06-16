/**
 * `@mithic/jq` — a pure-TypeScript jq JSON processor that runs as a sandboxed
 * Mithic process.
 *
 * Public surface:
 *   - the jq engine ({@link compile} / {@link run}) for embedding jq in JS, and
 *   - {@link resolveJq} / {@link createJqResolver}, a `resolveCommand` factory to
 *     hand to `new Kernel({ resolveCommand })` so guests can spawn `jq` by name.
 *
 * The engine (lexer → parser → interpreter + builtins) is also exported from
 * `@mithic/jq/engine` for consumers that only need the language, not the process.
 */
export { compile, run, JQError } from './engine.ts';
export type { CompiledFilter, RunOptions, Context } from './engine.ts';
export { createJqResolver, resolveJq, COMMAND_NAMES } from './resolver.ts';
export type { JqResolverOptions } from './resolver.ts';
export { parseJqArgs, formatOutput, parseInputs, parseJsonStream } from './cli.ts';
export type { JqOptions } from './cli.ts';
export { defineCommand } from './harness.ts';
export type { CommandFn, CommandIO } from './harness.ts';

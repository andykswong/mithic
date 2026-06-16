/**
 * `@mithic/coreutils` — pure-TypeScript Unix coreutils that run as regular
 * sandboxed Mithic processes (one guest module per command).
 *
 * Public surface:
 *   - the command-authoring harness ({@link CommandFn} / {@link CommandIO} and
 *     the reusable helpers commands build on), and
 *   - {@link createCoreutilsResolver}, a `resolveCommand` factory to hand to
 *     `new Kernel({ resolveCommand })` so guests can spawn coreutils by name.
 */
export type { CommandFn, CommandIO } from './harness.ts';
export {
  defineCommand,
  parseArgs,
  readAll,
  readAllText,
  readLines,
  writeBytes,
  writeString,
  writeLine,
  exitWith,
} from './harness.ts';
export type { ParsedArgs, ParseOptions } from './harness.ts';
export {
  createCoreutilsResolver,
  COMMAND_NAMES,
} from './resolver.ts';
export type { CoreutilsResolverOptions } from './resolver.ts';

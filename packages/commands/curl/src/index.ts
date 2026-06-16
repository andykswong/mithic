/**
 * `@mithic/curl` — a pure-TypeScript curl-like HTTP client that runs as a regular
 * sandboxed Mithic process. All network access funnels through the kernel's
 * capability-gated `net/fetch` syscall; the guest never holds a socket.
 *
 * Public surface:
 *   - the command-authoring harness ({@link CommandFn} / {@link CommandIO} and
 *     the reusable helpers), the {@link curlCommand} logic for direct testing,
 *     and
 *   - {@link createCurlResolver}, a `resolveCommand` factory to hand to
 *     `new Kernel({ resolveCommand })` so guests can spawn `curl` by name.
 */
export type { CommandFn, CommandIO, ParsedArgs, ParseOptions } from './harness.ts';
export {
  defineCommand,
  parseArgs,
  readAll,
  writeBytes,
  writeString,
  writeLine,
} from './harness.ts';
export { curlCommand } from './curl.ts';
export {
  createCurlResolver,
  COMMAND_NAMES,
} from './resolver.ts';
export type { CurlResolverOptions, CurlCommandName } from './resolver.ts';

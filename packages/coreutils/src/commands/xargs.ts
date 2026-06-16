/**
 * `xargs` — build and execute command lines from standard input.
 *
 * Reads items from stdin and runs a command (default: `echo`) with those items
 * appended as arguments. Supports batching, replace-strings, NUL/custom
 * delimiters, and the standard GNU xargs flag set.
 *
 * Child commands are spawned via `process/pipeline` (a single-stage pipeline
 * whose stdout is captured and forwarded to our own stdout). The caller must
 * grant xargs the `process` capability so the syscall is permitted.
 *
 * Supported flags:
 *   -n N            max args per invocation
 *   -L N            max input lines per invocation
 *   -I REPLSTR      replace-string (one item per invocation; whole line = item)
 *   -0 / --null     NUL-delimited input
 *   -d DELIM        custom single-character delimiter
 *   -r / --no-run-if-empty   skip execution if stdin yields no items
 *   -E EOF / -e EOF  stop reading at the EOF string
 *   -t              trace: print each command to stderr before running
 *   --              end flag parsing; rest is the command
 *
 * Exit codes (GNU parity):
 *   0   all invocations succeeded
 *   123 at least one invocation exited 1-125
 *   124 at least one invocation exited 255
 *   127 command not found (ENOENT from pipeline)
 */
import { defineCommand, readAllText, writeBytes, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/**
 * Parsed xargs flags extracted from argv[1..], along with the command-and-its-
 * args that remain after xargs flags are consumed.
 */
interface XargsFlags {
  maxArgs?: number;        // -n N
  maxLines?: number;       // -L N
  replStr?: string;        // -I REPLSTR
  useNull: boolean;        // -0 / --null
  customDelim?: string;    // -d DELIM
  noRunIfEmpty: boolean;   // -r / --no-run-if-empty
  eofString?: string;      // -E EOF / -e EOF
  trace: boolean;          // -t
  /** The command + its own args (everything after xargs flags). */
  cmd: string[];
}

/**
 * Parse xargs-specific flags from argv[1..].
 *
 * Crucially different from a generic getopt parser: once we see the first
 * non-flag token (the command name), we stop flag-parsing and treat the
 * remaining tokens verbatim as the command's argv. This lets `xargs ls -l`
 * pass `-l` to `ls`, not to xargs.
 */
function parseXargsFlags(args: string[]): XargsFlags {
  let maxArgs: number | undefined;
  let maxLines: number | undefined;
  let replStr: string | undefined;
  let useNull = false;
  let customDelim: string | undefined;
  let noRunIfEmpty = false;
  let eofString: string | undefined;
  let trace = false;

  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') { i++; break; }  // explicit end-of-flags

    // Long flags
    if (arg === '--null') { useNull = true; continue; }
    if (arg === '--no-run-if-empty') { noRunIfEmpty = true; continue; }
    if (arg.startsWith('--')) {
      // Unknown long flag: stop and treat as command
      break;
    }

    // Short flags
    if (arg.startsWith('-') && arg.length > 1) {
      // Parse the cluster character by character
      let j = 1;
      let consumed = false;
      while (j < arg.length) {
        const ch = arg[j];
        switch (ch) {
          case '0': useNull = true; j++; break;
          case 'r': noRunIfEmpty = true; j++; break;
          case 't': trace = true; j++; break;
          case 'n': {
            const rest = arg.slice(j + 1);
            if (rest.length > 0) { maxArgs = parseInt(rest, 10); j = arg.length; }
            else { maxArgs = parseInt(args[++i] ?? '1', 10); j = arg.length; }
            consumed = true; break;
          }
          case 'L': {
            const rest = arg.slice(j + 1);
            if (rest.length > 0) { maxLines = parseInt(rest, 10); j = arg.length; }
            else { maxLines = parseInt(args[++i] ?? '1', 10); j = arg.length; }
            consumed = true; break;
          }
          case 'I': {
            const rest = arg.slice(j + 1);
            if (rest.length > 0) { replStr = rest; j = arg.length; }
            else { replStr = args[++i] ?? '{}'; j = arg.length; }
            consumed = true; break;
          }
          case 'd': {
            const rest = arg.slice(j + 1);
            if (rest.length > 0) { customDelim = rest[0]; j = arg.length; }
            else { customDelim = (args[++i] ?? ':')?.[0]; j = arg.length; }
            consumed = true; break;
          }
          case 'E': {
            const rest = arg.slice(j + 1);
            if (rest.length > 0) { eofString = rest; j = arg.length; }
            else { eofString = args[++i] ?? ''; j = arg.length; }
            consumed = true; break;
          }
          case 'e': {
            // -e is optional: if the next arg looks like a flag or there's no next, disable eof
            const rest = arg.slice(j + 1);
            if (rest.length > 0) { eofString = rest; j = arg.length; }
            else {
              // Peek: if next arg exists and isn't a flag, consume it as eof-string
              const next = args[i + 1];
              if (next !== undefined && !next.startsWith('-')) {
                eofString = next; i++;
              } else {
                eofString = ''; // disable eof-string
              }
              j = arg.length;
            }
            consumed = true; break;
          }
          default:
            // Unknown short flag — stop and treat whole arg as command
            consumed = true;
            i--; // re-process this arg as positional
            j = arg.length;
        }
      }
      if (!consumed) continue; // All chars in cluster were xargs flags
      if (i >= 0 && i < args.length && args[i] === arg) continue; // consumed via j
      continue;
    }

    // Non-flag: this is the command name — stop flag parsing
    break;
  }

  return {
    maxArgs,
    maxLines,
    replStr,
    useNull,
    customDelim,
    noRunIfEmpty,
    eofString,
    trace,
    cmd: args.slice(i),
  };
}

/**
 * Split the raw stdin text into individual items using the chosen delimiter.
 * Returns items in order; empty items are dropped.
 */
function splitItems(text: string, delimiter: 'whitespace' | 'nul' | string): string[] {
  if (delimiter === 'nul') {
    return text.split('\0').filter((s) => s.length > 0);
  }
  if (delimiter === 'whitespace') {
    return text.split(/\s+/).filter((s) => s.length > 0);
  }
  // Custom delimiter: strip a single trailing newline (GNU xargs -d behaviour),
  // then split on the delimiter character and drop empty entries.
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
  return stripped.split(delimiter).map((s) => s.replace(/\n$/, '')).filter((s) => s.length > 0);
}

/**
 * Split text into lines; returns raw lines without trailing newline.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
}

/** Apply replace-string substitution to all occurrences in all template args. */
function applyReplstr(template: string[], replStr: string, item: string): string[] {
  return template.map((arg) => arg.split(replStr).join(item));
}

/**
 * Run one invocation of the child command via `process/pipeline`.
 * Returns the child's exit code and writes captured stdout to `outWriter`.
 */
async function runInvocation(
  io: CommandIO,
  argv: string[],
  outWriter: WritableStreamDefaultWriter<Uint8Array>,
  trace: boolean,
  errWriter: WritableStreamDefaultWriter<Uint8Array>,
): Promise<number> {
  if (trace) {
    await writeLine(errWriter, argv.join(' '));
  }
  const result = await io.syscall('process/pipeline', {
    stages: [{ path: argv[0], argv }],
  }) as { exitCodes: number[]; stdout: Uint8Array };
  if (result.stdout && result.stdout.byteLength > 0) {
    await writeBytes(outWriter, result.stdout);
  }
  return result.exitCodes[0] ?? 0;
}

/**
 * Map a child exit code to the xargs aggregate exit code.
 * Returns `null` if child succeeded (no change needed).
 */
function bucketExitCode(childCode: number): number | null {
  if (childCode === 0) return null;
  if (childCode === 255) return 124;
  return 123; // 1-125 and 126/127 all map to 123
}

const xargsCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const flags = parseXargsFlags(io.args.slice(1));

  // Command template: cmd[0] = command name, cmd[1..] = its initial fixed args.
  const cmdTemplate = flags.cmd.length > 0 ? flags.cmd : ['echo'];
  const cmdName = cmdTemplate[0];
  const cmdInitialArgs = cmdTemplate.slice(1);

  const stdinText = await readAllText(io.stdin);

  const outWriter = io.stdout.getWriter();
  const errWriter = io.stderr.getWriter();

  try {
    // Determine delimiter mode.
    let delimiter: 'whitespace' | 'nul' | string = 'whitespace';
    if (flags.useNull) delimiter = 'nul';
    else if (flags.customDelim) delimiter = flags.customDelim;

    // ── -I replace-string mode ───────────────────────────────────────────────
    // Each line is treated as one item; whitespace within a line is preserved.
    if (flags.replStr !== undefined) {
      const lines = splitLines(stdinText);
      if (lines.length === 0 && flags.noRunIfEmpty) return 0;

      let overallCode = 0;
      for (const line of lines) {
        if (flags.eofString && flags.eofString.length > 0 && line === flags.eofString) break;
        // Substitute the replStr in every position in the initial args template.
        const substituted = applyReplstr(cmdInitialArgs, flags.replStr, line);
        const argv = [cmdName, ...substituted];
        const childCode = await runInvocation(io, argv, outWriter, flags.trace, errWriter);
        const bucket = bucketExitCode(childCode);
        if (bucket === 124) return 124;
        if (bucket !== null && overallCode !== 124) overallCode = bucket;
      }
      return overallCode;
    }

    // ── -L max-lines mode ────────────────────────────────────────────────────
    // Group N input lines per invocation; each line's tokens are whitespace-split.
    if (flags.maxLines !== undefined) {
      const lines = splitLines(stdinText);
      if (lines.length === 0 && flags.noRunIfEmpty) return 0;

      let overallCode = 0;
      let done = false;
      for (let i = 0; i < lines.length && !done; i += flags.maxLines) {
        const batch = lines.slice(i, i + flags.maxLines);
        const items: string[] = [];
        for (const line of batch) {
          if (flags.eofString && flags.eofString.length > 0 && line === flags.eofString) {
            done = true; break;
          }
          items.push(...line.split(/\s+/).filter((s) => s.length > 0));
        }
        if (items.length === 0) continue;
        const argv = [cmdName, ...cmdInitialArgs, ...items];
        const childCode = await runInvocation(io, argv, outWriter, flags.trace, errWriter);
        const bucket = bucketExitCode(childCode);
        if (bucket === 124) return 124;
        if (bucket !== null && overallCode !== 124) overallCode = bucket;
      }
      return overallCode;
    }

    // ── default / -n mode ────────────────────────────────────────────────────
    const allItems = splitItems(stdinText, delimiter);

    // Apply EOF-string truncation.
    let items = allItems;
    if (flags.eofString && flags.eofString.length > 0) {
      const idx = items.indexOf(flags.eofString);
      if (idx >= 0) items = items.slice(0, idx);
    }

    if (items.length === 0 && flags.noRunIfEmpty) return 0;

    const batchSize = flags.maxArgs !== undefined && flags.maxArgs > 0 ? flags.maxArgs : undefined;
    let overallCode = 0;

    if (batchSize === undefined) {
      const argv = [cmdName, ...cmdInitialArgs, ...items];
      const childCode = await runInvocation(io, argv, outWriter, flags.trace, errWriter);
      const bucket = bucketExitCode(childCode);
      if (bucket === 124) return 124;
      if (bucket !== null) overallCode = bucket;
    } else {
      if (items.length === 0) {
        // No items but batchSize set and not -r: run once with no extra args.
        const argv = [cmdName, ...cmdInitialArgs];
        const childCode = await runInvocation(io, argv, outWriter, flags.trace, errWriter);
        const bucket = bucketExitCode(childCode);
        if (bucket === 124) return 124;
        if (bucket !== null) overallCode = bucket;
      } else {
        for (let i = 0; i < items.length; i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          const argv = [cmdName, ...cmdInitialArgs, ...batch];
          const childCode = await runInvocation(io, argv, outWriter, flags.trace, errWriter);
          const bucket = bucketExitCode(childCode);
          if (bucket === 124) return 124;
          if (bucket !== null && overallCode !== 124) overallCode = bucket;
        }
      }
    }

    return overallCode;
  } finally {
    await outWriter.close().catch(() => { /* already closed */ });
    await errWriter.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(xargsCommand);
export { xargsCommand };

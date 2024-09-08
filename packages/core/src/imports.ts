import {
  environment, exit, stdin, stdout, stderr, terminalInput, terminalOutput, terminalStderr, terminalStdin,
  terminalStdout
} from './cli/index.ts';
import { monotonicClock, wallClock } from './clocks/index.ts';
import { runtime as runtimeConfig } from './config/index.ts';
import { preopens, types as fsTypes } from './filesystem/index.ts';
import { error, poll, streams } from './io/index.ts';
import { logging } from './logging/index.ts';
import { insecure, insecureSeed, random } from './random/index.ts';

/** All runtime imports. */
export const imports = {
  'wasi:cli/environment': environment,
  'wasi:cli/exit': exit,
  'wasi:cli/stderr': stderr,
  'wasi:cli/stdin': stdin,
  'wasi:cli/stdout': stdout,
  'wasi:cli/terminal-input': terminalInput,
  'wasi:cli/terminal-output': terminalOutput,
  'wasi:cli/terminal-stderr': terminalStderr,
  'wasi:cli/terminal-stdin': terminalStdin,
  'wasi:cli/terminal-stdout': terminalStdout,
  'wasi:clocks/monotonic-clock': monotonicClock,
  'wasi:clocks/wall-clock': wallClock,
  'wasi:config/runtime': runtimeConfig,
  'wasi:filesystem/preopens': preopens,
  'wasi:filesystem/types': fsTypes,
  'wasi:io/error': error,
  'wasi:io/poll': poll,
  'wasi:io/streams': streams,
  'wasi:logging/logging': logging,
  'wasi:random/insecure': insecure,
  'wasi:random/insecure-seed': insecureSeed,
  'wasi:random/random': random,
} as const;

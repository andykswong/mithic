/**
 * Implements wasi:cli terminal interfaces.
 * Returns terminal instances only when the corresponding stream has isatty=true.
 * jco transpiled code checks whether the return value is non-null
 * to determine terminal capability.
 */

import { getStdin, getStdout, getStderr } from './stdio.ts';

export class TerminalInput {}
export class TerminalOutput {}

const terminalStdinInstance = new TerminalInput();
const terminalStdoutInstance = new TerminalOutput();
const terminalStderrInstance = new TerminalOutput();

export const terminalInput = { TerminalInput };
export const terminalOutput = { TerminalOutput };

export const terminalStdin = {
  TerminalInput,
  getTerminalStdin(): TerminalInput | undefined {
    return getStdin().isatty ? terminalStdinInstance : undefined;
  },
};

export const terminalStdout = {
  TerminalOutput,
  getTerminalStdout(): TerminalOutput | undefined {
    return getStdout().isatty ? terminalStdoutInstance : undefined;
  },
};

export const terminalStderr = {
  TerminalOutput,
  getTerminalStderr(): TerminalOutput | undefined {
    return getStderr().isatty ? terminalStderrInstance : undefined;
  },
};

/**
 * Implements wasi:cli terminal interfaces.
 * Returns terminal instances to match jco's expectations.
 * jco transpiled code checks whether the return value is non-null
 * to determine terminal capability.
 */

export class TerminalInput {}
export class TerminalOutput {}

const terminalStdinInstance = new TerminalInput();
const terminalStdoutInstance = new TerminalOutput();
const terminalStderrInstance = new TerminalOutput();

export const terminalInput = { TerminalInput };
export const terminalOutput = { TerminalOutput };

export const terminalStdin = {
  TerminalInput,
  getTerminalStdin(): TerminalInput {
    return terminalStdinInstance;
  },
};

export const terminalStdout = {
  TerminalOutput,
  getTerminalStdout(): TerminalOutput {
    return terminalStdoutInstance;
  },
};

export const terminalStderr = {
  TerminalOutput,
  getTerminalStderr(): TerminalOutput {
    return terminalStderrInstance;
  },
};

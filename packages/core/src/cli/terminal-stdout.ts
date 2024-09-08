import { TerminalOutput } from './terminal-output.ts';

/**
 * If stdout is connected to a terminal, return a TerminalOutput handle allowing further interaction with it.
 */
export function getTerminalStdout() {
   return new TerminalOutput();
}

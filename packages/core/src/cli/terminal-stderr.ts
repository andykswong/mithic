import { TerminalOutput } from './terminal-output.ts';

/**
 * If stderr is connected to a terminal, return a TerminalOutput handle allowing further interaction with it.
 */
export function getTerminalStderr() {
   return new TerminalOutput(true);
}

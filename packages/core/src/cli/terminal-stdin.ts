import { TerminalInput } from './terminal-input.ts';

/**
 * If stdin is connected to a terminal, return a TerminalInput handle allowing further interaction with it.
 */
export function getTerminalStdin() {
   return new TerminalInput();
}

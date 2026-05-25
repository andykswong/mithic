/**
 * wasi:cli module barrel exports.
 * Each export maps directly to a WASI interface shape.
 */

export { environment } from './environment.ts';
export * as exit from './exit.ts';
export { stdin, stdout, stderr } from './stdio.ts';
export { terminalInput, terminalOutput, terminalStdin, terminalStdout, terminalStderr } from './terminal.ts';

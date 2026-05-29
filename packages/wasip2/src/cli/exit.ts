/**
 * Implements wasi:cli/exit - process exit.
 */

export class ComponentExit extends Error {
  exitError: boolean;
  code: number;

  constructor(code: number) {
    super(`Component exited ${code === 0 ? 'successfully' : 'with error'}`);
    this.exitError = true;
    this.code = code;
  }
}

export function exit(status: { tag: 'ok' } | { tag: 'err'; val?: unknown }): void {
  if (status.tag === 'err') {
    const code = typeof status.val === 'number' ? status.val : 1;
    throw new ComponentExit(code);
  }
  throw new ComponentExit(0);
}

export function exitWithCode(statusCode: number): void {
  throw new ComponentExit(statusCode);
}

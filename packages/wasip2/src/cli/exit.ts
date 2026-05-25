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
  throw new ComponentExit(status.tag === 'err' ? 1 : 0);
}

export function exitWithCode(statusCode: number): void {
  throw new ComponentExit(statusCode);
}

/**
 * Implements wasi:cli/environment - environment variables, arguments, and CWD.
 */

let _env: [string, string][] = [];
let _args: string[] = [];
let _cwd = '/';

export function getEnvironment(): [string, string][] {
  return _env;
}

export function getArguments(): string[] {
  return _args;
}

export function initialCwd(): string | undefined {
  return _cwd;
}

export function _setEnv(env: Record<string, string>): void {
  _env = Object.entries(env);
}

export function _setArgs(args: string[]): void {
  _args = args;
}

export function _setCwd(cwd: string): void {
  _cwd = cwd;
}

export const environment = {
  getEnvironment,
  getArguments,
  initialCwd,
};

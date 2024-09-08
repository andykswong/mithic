const CWD_VAR = 'PWD';

/** Get the POSIX-style environment variables. */
export function getEnvironment(): [key: string, value: string][] {
  const env: [string, string][] = [];
  for (const [key, value] of Object.entries(globalThis.process?.env || {})) {
    if (value !== undefined) {
      env.push([key, `${value}`]);
    }
  }
  return env;
}

/** Get the POSIX-style arguments to the program. */
export function getArguments(): string[] {
  return globalThis.process?.argv?.slice(1) || [];
}

/**
 * Return a path that programs should use as their initial current working directory.
 * Implementation: checks the PWD env variable.
 */
export function initialCwd(): string | undefined {
  return getEnvironment().find(([key]) => key === CWD_VAR)?.[1];
}

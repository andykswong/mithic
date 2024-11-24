/**
 * Helper function to set environment variables for web worker.
 * Defaults to use search params from location for process.env and process.argv.
 */
export function setupEnvironment(useSearchParams = true) {
  const process = globalThis.process = globalThis.process ?? {};
  process.argv = process.argv ?? [];
  process.env = process.env ?? {};

  const location = globalThis.location;
  if (!useSearchParams || !location) {
    return;
  }

  const params = new URLSearchParams(location.search);
  process.argv.push(location.href, ...params.getAll('argv'));
  for (const [key, value] of params.entries()) {
    if (key === 'argv') {
      continue;
    }
    process.env[key] = value;
  }
}

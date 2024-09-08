import type { Result } from '@mithic/commons';

/** Exit the current instance. */
export function exit(status: Result): void {
  const statusCode = status?.tag === 'err' ? 1 : 0;
  globalThis.process?.exit?.(statusCode);
  globalThis.close?.(); // fallback
}

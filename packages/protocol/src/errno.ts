export const ERRNO_CODES = [
  'EACCES', 'EBADF', 'EBUSY', 'EEXIST', 'EFAULT',
  'EINVAL', 'EIO', 'EISDIR', 'EMFILE', 'ENAMETOOLONG',
  'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM',
  'EPIPE', 'ESRCH', 'ETIMEDOUT', 'EXDEV', 'EAGAIN', 'ENOSYS',
  'ELOOP', 'EROFS', 'EHOSTUNREACH', 'ECONNREFUSED', 'ENETUNREACH',
] as const;
export type ErrnoCode = typeof ERRNO_CODES[number];

export function isErrnoCode(x: unknown): x is ErrnoCode {
  return typeof x === 'string' && (ERRNO_CODES as readonly string[]).includes(x);
}

export const SIGNALS = [
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGTERM', 'SIGSTOP', 'SIGCONT',
  'SIGPIPE', 'SIGCHLD', 'SIGUSR1', 'SIGUSR2',
] as const;
export type Signal = typeof SIGNALS[number];

/**
 * POSIX signal numbers. A process terminated by signal N exits with status
 * `128 + N` (so SIGKILL=137, SIGTERM=143, SIGINT=130) — see the WASM reference
 * process model (`manager/simple.ts`). Used by the kernel to compute the exit
 * code of a process killed by signal.
 */
export const SIGNAL_NUMBER: Record<Signal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
};

/** Exit status of a process terminated by signal `signal` (POSIX `128 + signum`). */
export function signalExitCode(signal: Signal): number {
  return 128 + (SIGNAL_NUMBER[signal] ?? 0);
}

/**
 * Signals that, when UNHANDLED by a guest, terminate the process (after a grace
 * window for deliverable ones). SIGKILL is terminating but undeliverable (hard
 * teardown). SIGCHLD/SIGCONT/SIGUSR1/SIGUSR2 are deliverable but NON-terminating
 * (the guest decides what to do; the kernel never tears the process down for them).
 */
const TERMINATING_SIGNALS = new Set<Signal>([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGTERM', 'SIGPIPE',
]);

/** True if an unhandled `signal` should terminate the process. */
export function isTerminatingSignal(signal: Signal): boolean {
  return TERMINATING_SIGNALS.has(signal);
}

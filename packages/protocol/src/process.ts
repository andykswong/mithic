export type OFlags = { create?: boolean; exclusive?: boolean; truncate?: boolean; directory?: boolean; append?: boolean; write?: boolean; read?: boolean };

export interface FdRights { read: boolean; write: boolean; seek: boolean; stat: boolean; truncate: boolean }
export interface FdFlags { append: boolean; nonblock: boolean }

export interface PreopenDescriptor {
  type: 'pipe' | 'file' | 'directory' | 'socket';
  path?: string;
  rights?: Partial<FdRights>;
  /**
   * POSIX `isatty`: true if this fd is connected to an INTERACTIVE terminal
   * rather than a plain pipe/file/redirect. Only meaningful on stream fds
   * (stdin/stdout/stderr). Absent/false = a non-interactive pipe. A guest reads
   * this (via the bootstrap → `guest.isatty(fd)`) to decide whether to colorize,
   * prompt interactively, or run in batch mode. The kernel sets it from
   * `SpawnInit.tty`; the shell/terminal mark 0/1/2 true when interactive.
   */
  tty?: boolean;
}

export type Capability =
  | { type: 'fs'; paths: string[]; operations: ('read' | 'write' | 'execute')[] }
  | { type: 'net'; origins: string[] }
  | { type: 'ipc'; channels: string[] }
  | { type: 'process'; maxChildren?: number }
  | { type: 'env' };

export interface ProcessLimits {
  memoryMb?: number;
  cpuMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxChildren?: number;
  networkDisabled?: boolean;
}

/**
 * What the guest learns at boot about its display surface — it does NOT request
 * one (the host/manifest decides geometry). `available:false` means there is no
 * GUI surface at all (e.g. a server/Node host, or a process spawned `hidden`), so
 * an app should run headless/CLI. When `available:true`, `width`/`height` are the
 * actual pixel size the host allocated (from the app manifest's `defaultSize`).
 */
export interface DisplayInfo {
  available: boolean;
  mode?: 'inline' | 'window' | 'fullscreen';
  width?: number;
  height?: number;
  title?: string;
}

export interface ProcessInit {
  type: 'init';
  entry: string | URL;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  pid: number;
  ppid: number;
  uid?: number;
  capabilities: Capability[];
  limits?: ProcessLimits;
  preopens?: Record<number, PreopenDescriptor>;
  /** GUI surface info the guest learns at boot (see {@link DisplayInfo}). Absent = unknown/headless. */
  display?: DisplayInfo;
}

export interface ProcessReady { type: 'ready' }
export interface ProcessExit { type: 'exit'; code: number }

export function isProcessReady(x: unknown): x is ProcessReady {
  return typeof x === 'object' && x !== null && (x as { type?: unknown }).type === 'ready';
}

export function isProcessExit(x: unknown): x is ProcessExit {
  return typeof x === 'object' && x !== null
    && (x as { type?: unknown }).type === 'exit'
    && typeof (x as { code?: unknown }).code === 'number';
}

export type FdAction =
  | { action: 'inherit' }
  | { action: 'pipe' }
  | { action: 'open'; path: string; flags: OFlags }
  | { action: 'bytes'; data: Uint8Array }
  | { action: 'close' }
  | { action: 'dup2'; from: number };

export interface SpawnArgs {
  path: string;
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  fds?: Record<number, FdAction>;
  /**
   * A1: inline stdin bytes for the child. When set and fd 0 is not otherwise
   * wired (no `fds[0]` pipe/dup2/open), the kernel mints a stdin pipe, feeds
   * these bytes, and closes the write end (EOF) so a stdin-reading child does
   * not block. Mirrors the per-stage `stdinData` of `process/pipeline`.
   */
  stdinData?: Uint8Array;
}

export interface SpawnResult {
  pid: number;
  pipes?: Record<number, 'transferred'>;
}

export const DEFAULT_FD_ACTIONS: Record<number, FdAction> = {
  0: { action: 'inherit' },
  1: { action: 'inherit' },
  2: { action: 'inherit' },
};

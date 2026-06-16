export type OFlags = { create?: boolean; exclusive?: boolean; truncate?: boolean; directory?: boolean; append?: boolean; write?: boolean; read?: boolean };

export interface FdRights { read: boolean; write: boolean; seek: boolean; stat: boolean; truncate: boolean }
export interface FdFlags { append: boolean; nonblock: boolean }

export interface PreopenDescriptor {
  type: 'pipe' | 'file' | 'directory' | 'socket';
  path?: string;
  rights?: Partial<FdRights>;
}

export interface Capability {
  type: 'fs' | 'net' | 'ipc' | 'process' | 'env';
  paths?: string[];
  operations?: ('read' | 'write' | 'execute')[];
  origins?: string[];
  channels?: string[];
  maxChildren?: number;
}

export interface ProcessLimits {
  memoryMb?: number;
  cpuMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxChildren?: number;
  networkDisabled?: boolean;
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
}

export interface ProcessReady { type: 'ready' }
export interface ProcessExit { type: 'exit'; code: number }

export type FdAction =
  | { action: 'inherit' }
  | { action: 'pipe' }
  | { action: 'open'; path: string; flags: OFlags }
  | { action: 'close' }
  | { action: 'dup2'; from: number };

export interface SpawnArgs {
  path: string;
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  fds?: Record<number, FdAction>;
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

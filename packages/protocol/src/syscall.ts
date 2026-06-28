import type { OFlags, SpawnArgs, FdAction } from './process.ts';

/**
 * C2: the typed syscall discriminated union. This is the SINGLE source of truth
 * for the set of calls the kernel dispatcher handles and the SHAPE of each
 * call's `args`. The dispatcher's handler map is keyed by `Syscall['call']` so
 * exhaustiveness is compiler-checked: adding a member here without a handler is
 * a build error, and removing a handler for a still-listed member is too.
 *
 * IMPORTANT (trust boundary): this union describes the INTENDED shape, not a
 * validated one. The syscall seam crosses postMessage / QuickJS bridges where
 * guest input is UNTRUSTED, so the union does NOT remove runtime validation —
 * each handler still parses its `args` once at the boundary. Capability checks
 * run in-kernel regardless. This type is for maintainability / type-safety, not
 * security.
 */

/** Common arg-shape for the path-resolving fs calls (resolved vs. dirfd). */
export interface FsPathArgs {
  path: string;
  dirfd?: number;
}

/** `net/fetch` args (the only network surface a guest gets). */
export interface NetFetchArgs {
  method?: string;
  url: string;
  headers?: [string, string][];
  body?: Uint8Array | ArrayBuffer | string;
  timeoutMs?: number;
}

/** One stage of a `process/pipeline` request. */
export interface PipelineStageArgs {
  path?: string;
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdinData?: Uint8Array;
}

export type Syscall =
  // --- fs/* ---
  | { call: 'fs/open'; args: FsPathArgs & { oflags?: OFlags } }
  | { call: 'fs/read'; args: { fd: number; len?: number; offset?: number } }
  | { call: 'fs/write'; args: { fd: number; data: Uint8Array | ArrayBuffer | string; offset?: number } }
  | { call: 'fs/close'; args: { fd: number } }
  | { call: 'fs/stat'; args: FsPathArgs & { followSymlinks?: boolean } }
  | { call: 'fs/readdir'; args: FsPathArgs }
  | { call: 'fs/mkdir'; args: FsPathArgs }
  | { call: 'fs/unlink'; args: FsPathArgs }
  | { call: 'fs/rmdir'; args: FsPathArgs }
  | { call: 'fs/rename'; args: FsPathArgs & { newPath: string } }
  | { call: 'fs/symlink'; args: FsPathArgs & { target: string } }
  | { call: 'fs/readlink'; args: FsPathArgs }
  | { call: 'fs/link'; args: FsPathArgs & { target: string } }
  | { call: 'fs/chmod'; args: FsPathArgs & { mode?: number } }
  | { call: 'fs/utimes'; args: FsPathArgs & { atime?: number; mtime?: number } }
  | { call: 'fs/realpath'; args: FsPathArgs }
  | { call: 'fs/getxattr'; args: FsPathArgs & { name: string } }
  | { call: 'fs/setxattr'; args: FsPathArgs & { name: string; value: Uint8Array } }
  | { call: 'fs/listxattr'; args: FsPathArgs }
  | { call: 'fs/removexattr'; args: FsPathArgs & { name: string } }
  | { call: 'fs/pipe'; args: Record<string, never> }
  // --- ipc/* ---
  | { call: 'ipc/listen'; args: { path: string } }
  | { call: 'ipc/accept'; args: { fd: number } }
  | { call: 'ipc/connect'; args: { path: string } }
  // --- dom/* ---
  | { call: 'dom/mutate'; args: { mutations: unknown[] } }
  // --- net/* ---
  | { call: 'net/fetch'; args: NetFetchArgs }
  // --- process/* ---
  | { call: 'process/spawn'; args: SpawnArgs & { portFds?: number[] } }
  | { call: 'process/pipeline'; args: { stages: PipelineStageArgs[] } }
  | { call: 'process/wait'; args: { pid: number } }
  | { call: 'process/kill'; args: { pid: number; signal?: string } }
  | { call: 'process/exit'; args: { code?: number } }
  | { call: 'process/getpid'; args: Record<string, never> }
  | { call: 'process/getppid'; args: Record<string, never> }
  | { call: 'process/getcwd'; args: Record<string, never> }
  | { call: 'process/chdir'; args: { path: string } }
  // --- pipe/* (relay byte-channel: first-class union members, NOT a side-channel
  //     dialect). Used on non-transferable (relay) backends where the guest drives
  //     kernel-held pipe/IPC ends by fd. ---
  | { call: 'pipe/read'; args: { fd: number; len?: number } }
  | { call: 'pipe/write'; args: { fd: number; data: Uint8Array | number[] | string } }
  | { call: 'pipe/close'; args: { fd: number } };

/** The set of all syscall call names (the discriminants of {@link Syscall}). */
export type SyscallName = Syscall['call'];

/**
 * Runtime registry of every known syscall name. Kept in lock-step with the
 * {@link Syscall} union via the `satisfies` check below: if a member is added to
 * the union without a name here (or vice versa) it is a compile error in the
 * dispatcher's handler map, and {@link isSyscallName} stays accurate.
 */
export const SYSCALL_NAMES = [
  'fs/open',
  'fs/read',
  'fs/write',
  'fs/close',
  'fs/stat',
  'fs/readdir',
  'fs/mkdir',
  'fs/unlink',
  'fs/rmdir',
  'fs/rename',
  'fs/symlink',
  'fs/readlink',
  'fs/link',
  'fs/chmod',
  'fs/utimes',
  'fs/realpath',
  'fs/getxattr',
  'fs/setxattr',
  'fs/listxattr',
  'fs/removexattr',
  'fs/pipe',
  'ipc/listen',
  'ipc/accept',
  'ipc/connect',
  'dom/mutate',
  'net/fetch',
  'process/spawn',
  'process/pipeline',
  'process/wait',
  'process/kill',
  'process/exit',
  'process/getpid',
  'process/getppid',
  'process/getcwd',
  'process/chdir',
  'pipe/read',
  'pipe/write',
  'pipe/close',
] as const satisfies readonly SyscallName[];

const SYSCALL_NAME_SET: ReadonlySet<string> = new Set(SYSCALL_NAMES);

/** True if `call` is a known syscall name. */
export function isSyscallName(call: string): call is SyscallName {
  return SYSCALL_NAME_SET.has(call);
}

/** Re-derive the args type for a given syscall name from the union. */
export type SyscallArgs<C extends SyscallName> = Extract<Syscall, { call: C }>['args'];

/** Re-used reference so {@link FdAction} stays imported (process/spawn fds). */
export type { FdAction };

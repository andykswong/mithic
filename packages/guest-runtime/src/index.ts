export { createGuest } from './guest.ts';
export type { Guest, GuestOptions } from './guest.ts';
export type { DisplayInfo } from '@mithic/protocol';
export { createFetch } from './fetch.ts';
export type { SyscallHook, PortsSyscallHook } from './fetch.ts';
export {
  openRoot,
  createStorageManager,
  readPath,
  writePath,
  GuestDirectoryHandle,
  GuestFileHandle,
  GuestFile,
  GuestWritableFileStream,
} from './fs-access.ts';
export type { GetHandleOptions, WritableChunk, GuestStorageManager, PathContext } from './fs-access.ts';
export { FdTable } from './fd-table.ts';
export type { FdEntry } from './fd-table.ts';
export { SyscallClient } from './syscall-client.ts';
export type { SyscallResult, SyscallCallOptions } from './syscall-client.ts';
export { MessagePortTransport } from './transport.ts';
export type { Transport } from './transport.ts';
export { portToReadable, portToWritable, portToDuplex } from './streams.ts';
export { MutationSerializer, VNode } from './remote-dom.ts';
export type { DomMutation } from './remote-dom.ts';

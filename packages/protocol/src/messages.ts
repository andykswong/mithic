import type { ErrnoCode } from './errno.ts';

export interface SyscallRequest {
  id: number;
  call: string;
  args: Record<string, unknown>;
}

export type SyscallResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: ErrnoCode; message: string } };

export interface KernelEvent {
  event: string;
  payload?: unknown;
}

export function makeSyscallRequest(id: number, call: string, args: Record<string, unknown>): SyscallRequest {
  return { id, call, args };
}

export function isSyscallResponse(x: unknown): x is SyscallResponse {
  return typeof x === 'object' && x !== null
    && 'id' in x && typeof (x as { id: unknown }).id === 'number'
    && 'ok' in x && typeof (x as { ok: unknown }).ok === 'boolean';
}

export function isKernelEvent(x: unknown): x is KernelEvent {
  return typeof x === 'object' && x !== null
    && 'event' in x && typeof (x as { event: unknown }).event === 'string'
    && !('id' in x);
}

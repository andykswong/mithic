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

/**
 * The well-known `KernelEvent.event` name for a progress update (RFC 0001 §4.5,
 * G15). A long-running guest emits `{ event: PROGRESS_EVENT, payload: ProgressPayload }`
 * so a host widget can render its progress. `KernelEvent` stays open-ended — this
 * is a typed name + payload for one variant, not a closed union.
 */
export const PROGRESS_EVENT = 'progress';

/** Payload of a {@link PROGRESS_EVENT} `KernelEvent`. */
export interface ProgressPayload {
  /** Completion in `[0, 1]`. */
  fraction: number;
  /** Optional human-readable status (e.g. `"resizing"`). */
  message?: string;
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

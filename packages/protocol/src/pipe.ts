export interface PipeData { type: 'data'; chunk: Uint8Array }
export interface PipeEnd { type: 'end' }
export interface PipeError { type: 'error'; code: 'EPIPE' }
export interface PipeCredit { type: 'credit'; bytes: number }
export type PipeMessage = PipeData | PipeEnd | PipeError | PipeCredit;

export const TRANSFER_THRESHOLD_BYTES = 10 * 1024;
export const PIPE_FLUSH_BYTES = 16 * 1024;
export const PIPE_FLUSH_MS = 4;
export const INITIAL_CREDIT_BYTES = 64 * 1024;

export function isPipeMessage(x: unknown): x is PipeMessage {
  if (typeof x !== 'object' || x === null || !('type' in x)) return false;
  return ['data', 'end', 'error', 'credit'].includes((x as { type: string }).type);
}

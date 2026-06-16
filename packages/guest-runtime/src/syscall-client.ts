import { isSyscallResponse } from '@mithic/protocol';
import type { Transport } from './transport.ts';

export interface SyscallClientOptions {
  /**
   * Optional per-call wall-clock timeout in milliseconds. When set, any
   * syscall that receives no response within `timeoutMs` ms is rejected with
   * an error carrying `code: 'ETIMEDOUT'`. Default: undefined (no timeout —
   * preserves the original behaviour so existing tests are unaffected).
   */
  timeoutMs?: number;
}

export class SyscallClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> }>();
  private transport: Transport;
  private timeoutMs: number | undefined;

  constructor(transport: Transport, options: SyscallClientOptions = {}) {
    this.transport = transport;
    this.timeoutMs = options.timeoutMs;
    transport.onMessage((msg) => {
      if (!isSyscallResponse(msg)) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer !== undefined) clearTimeout(p.timer);
      if (msg.ok) {
        p.resolve(msg.result);
      } else {
        const err = Object.assign(new Error(msg.error.message), { code: msg.error.code });
        p.reject(err);
      }
    });
  }

  syscall(call: string, args: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (this.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(Object.assign(new Error(`syscall timed out: ${call}`), { code: 'ETIMEDOUT' }));
          }
        }, this.timeoutMs);
      }
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ id, call, args });
    });
  }

  /** Rejects all in-flight syscalls and closes the underlying transport. */
  close(): void {
    const err = Object.assign(new Error('transport closed'), { code: 'EPIPE' });
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
    this.transport.close();
  }
}

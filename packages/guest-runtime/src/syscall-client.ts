import { isSyscallResponse } from '@mithic/protocol';
import type { Transport } from './transport.ts';

export class SyscallClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onMessage((msg) => {
      if (!isSyscallResponse(msg)) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
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
      this.pending.set(id, { resolve, reject });
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

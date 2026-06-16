import type { Signal } from '@mithic/protocol';

export type ProcessState = 'LOADING' | 'RUNNING' | 'EXITING' | 'DEAD';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  state: ProcessState;
  exitCode?: number;
  reaped: boolean;
}

export type WaitStatus = 'exited' | 'signalled';

export interface WaitResult {
  pid: number;
  status: WaitStatus;
  code: number;
}

type SignalListener = (signal: Signal | string, payload?: unknown) => void;

/**
 * Tracks process lifecycle: PID allocation/recycling, the
 * LOADING→RUNNING→EXITING→DEAD state machine, parent/child relationships,
 * SIGCHLD delivery, `wait()` reaping, and orphan reparenting to PID 0 (kernel).
 */
export class ProcessManager {
  #processes = new Map<number, ProcessEntry>();
  #nextPid = 1;
  #freePids: number[] = [];
  #signalListeners = new Map<number, SignalListener[]>();
  #waiters = new Map<number, Array<(r: WaitResult) => void>>();

  /** Allocate a fresh PID in LOADING state with the given parent. */
  allocate(ppid: number): number {
    const pid = this.#freePids.shift() ?? this.#nextPid++;
    this.#processes.set(pid, { pid, ppid, state: 'LOADING', reaped: false });
    return pid;
  }

  /** Look up a process entry. */
  get(pid: number): ProcessEntry | undefined {
    return this.#processes.get(pid);
  }

  /** All currently tracked processes. */
  list(): ProcessEntry[] {
    return [...this.#processes.values()];
  }

  /** Transition a process from LOADING to RUNNING. */
  markReady(pid: number): void {
    const entry = this.#processes.get(pid);
    if (entry && entry.state === 'LOADING') entry.state = 'RUNNING';
  }

  /**
   * Mark a process DEAD with an exit code. Reparents its children to PID 0,
   * delivers SIGCHLD to the parent, and resolves any pending `wait()`s.
   */
  markExit(pid: number, code: number): void {
    const entry = this.#processes.get(pid);
    if (!entry || entry.state === 'DEAD') return;
    entry.state = 'DEAD';
    entry.exitCode = code;

    // Reparent orphans to the kernel (PID 0).
    for (const child of this.#processes.values()) {
      if (child.ppid === pid) child.ppid = 0;
    }

    // Notify the parent and resolve waiters.
    this.#signal(entry.ppid, 'SIGCHLD');
    this.#resolveWaiters(pid, { pid, status: 'exited', code });
    this.#release(pid);
  }

  /**
   * Wait for a process to exit. Resolves immediately if the process is already
   * a zombie (DEAD but unreaped). Reaps the process on resolution.
   */
  wait(pid: number): Promise<WaitResult> {
    const entry = this.#processes.get(pid);
    if (entry && entry.state === 'DEAD' && !entry.reaped) {
      const result: WaitResult = { pid, status: 'exited', code: entry.exitCode ?? 0 };
      this.#reap(pid);
      return Promise.resolve(result);
    }
    return new Promise<WaitResult>(resolve => {
      const list = this.#waiters.get(pid) ?? [];
      list.push(resolve);
      this.#waiters.set(pid, list);
    });
  }

  /** Register a signal listener for a process. Returns an unsubscribe fn. */
  onSignal(pid: number, cb: SignalListener): () => void {
    const list = this.#signalListeners.get(pid) ?? [];
    list.push(cb);
    this.#signalListeners.set(pid, list);
    return () => {
      const cur = this.#signalListeners.get(pid);
      if (!cur) return;
      const i = cur.indexOf(cb);
      if (i >= 0) cur.splice(i, 1);
    };
  }

  /** Deliver a signal to a process's listeners. */
  signal(pid: number, signal: Signal | string, payload?: unknown): void {
    this.#signal(pid, signal, payload);
  }

  #signal(pid: number, signal: Signal | string, payload?: unknown): void {
    for (const cb of this.#signalListeners.get(pid) ?? []) cb(signal, payload);
  }

  #resolveWaiters(pid: number, result: WaitResult): void {
    const list = this.#waiters.get(pid);
    if (!list || list.length === 0) return;
    this.#waiters.delete(pid);
    this.#reap(pid);
    for (const resolve of list) resolve(result);
  }

  /** Mark reaped and recycle the PID; drops listener state. */
  #reap(pid: number): void {
    const entry = this.#processes.get(pid);
    if (entry) entry.reaped = true;
    this.#release(pid);
  }

  #release(pid: number): void {
    const entry = this.#processes.get(pid);
    if (entry?.reaped) {
      this.#processes.delete(pid);
      this.#signalListeners.delete(pid);
      this.#freePids.push(pid);
    }
  }
}

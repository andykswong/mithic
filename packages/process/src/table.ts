import type { Process } from './types.ts';

export interface ProcessEntry {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startTime: Date;
  process: Process;
}

/**
 * Tracks active processes by PID.
 */
export class ProcessTable {
  #nextPid = 1;
  #processes = new Map<number, ProcessEntry>();

  allocPid(): number {
    return this.#nextPid++;
  }

  register(pid: number, process: ProcessEntry): void {
    this.#processes.set(pid, process);
  }

  get(pid: number): ProcessEntry | undefined {
    return this.#processes.get(pid);
  }

  remove(pid: number): boolean {
    return this.#processes.delete(pid);
  }

  list(): ProcessEntry[] {
    return [...this.#processes.values()];
  }

  get size(): number {
    return this.#processes.size;
  }
}

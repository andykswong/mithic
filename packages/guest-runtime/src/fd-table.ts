import type { FdFlags, FdRights } from '@mithic/protocol';

export interface FdEntry {
  type: 'pipe' | 'file' | 'directory' | 'socket';
  port: MessagePort;
  rights: FdRights;
  flags: FdFlags;
}

export class FdTable {
  private table = new Map<number, FdEntry>();
  private nextFd = 3;

  add(entry: FdEntry): number {
    while (this.table.has(this.nextFd)) this.nextFd++;
    const fd = this.nextFd++;
    this.table.set(fd, entry);
    return fd;
  }

  set(fd: number, entry: FdEntry): void {
    this.table.set(fd, entry);
  }

  get(fd: number): FdEntry | undefined {
    return this.table.get(fd);
  }

  close(fd: number): void {
    this.table.delete(fd);
  }

  detach(fd: number): MessagePort | undefined {
    const entry = this.table.get(fd);
    if (!entry) return undefined;
    this.table.delete(fd);
    return entry.port;
  }
}

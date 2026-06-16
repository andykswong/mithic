import type { FdFlags, FdRights } from '@mithic/protocol';

export interface FdEntry {
  fd: number;
  rights: FdRights;
  flags: FdFlags;
  readable?: ReadableStream<Uint8Array>;
  writable?: WritableStream<Uint8Array>;
}

const DEFAULT_RIGHTS: FdRights = { read: true, write: true, seek: true, stat: true, truncate: true };
const DEFAULT_FLAGS: FdFlags = { append: false, nonblock: false };

export class FdTable {
  private entries = new Map<number, FdEntry>();
  private nextFd = 3;

  set(fd: number, entry: Omit<FdEntry, 'fd'>): void {
    this.entries.set(fd, { fd, ...entry });
    if (fd >= this.nextFd) this.nextFd = fd + 1;
  }

  get(fd: number): FdEntry | undefined {
    return this.entries.get(fd);
  }

  alloc(entry: Omit<FdEntry, 'fd'>): number {
    const fd = this.nextFd++;
    this.entries.set(fd, { fd, ...entry });
    return fd;
  }

  close(fd: number): boolean {
    return this.entries.delete(fd);
  }

  has(fd: number): boolean {
    return this.entries.has(fd);
  }

  get size(): number {
    return this.entries.size;
  }
}

export function makeDefaultEntry(overrides?: Partial<Omit<FdEntry, 'fd'>>): Omit<FdEntry, 'fd'> {
  return {
    rights: { ...DEFAULT_RIGHTS },
    flags: { ...DEFAULT_FLAGS },
    ...overrides,
  };
}

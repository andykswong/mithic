/** A unidirectional pipe: data flows from `writePort` to `readPort`. */
export interface Pipe {
  readPort: MessagePort;
  writePort: MessagePort;
}

/** A bidirectional connection: the two ends of a single MessageChannel. */
export interface Connection {
  localPort: MessagePort;
  remotePort: MessagePort;
}

/**
 * Brokers inter-process communication primitives.
 *
 * - `createPipe()` mints a fresh `MessageChannel`; `port1` is the reader and
 *   `port2` the writer. These are transferred into processes as stdio/pipe fds.
 * - Named channels model Unix-domain sockets living under `ipc/` in the VFS:
 *   a listener process `bind`s a path, peers `resolveListener` it, then connect.
 */
export class IpcBroker {
  #registry = new Map<string, number>();

  /** Create a one-way pipe backed by a single MessageChannel. */
  createPipe(): Pipe {
    const channel = new MessageChannel();
    return { readPort: channel.port1, writePort: channel.port2 };
  }

  /**
   * Open a connection toward a listener. Returns both ends of a MessageChannel;
   * `localPort` stays with the connecting side, `remotePort` is delivered to the
   * listener (`listenerPid`).
   */
  connect(listenerPid: number): Connection {
    void listenerPid;
    const channel = new MessageChannel();
    return { localPort: channel.port1, remotePort: channel.port2 };
  }

  /** Register a named channel (Unix-domain socket) owned by a listener process. */
  bind(path: string, listenerPid: number): void {
    this.#registry.set(path, listenerPid);
  }

  /** Remove a named channel binding. */
  unbind(path: string): void {
    this.#registry.delete(path);
  }

  /** Resolve the listener PID bound to a named channel, or undefined. */
  resolveListener(path: string): number | undefined {
    return this.#registry.get(path);
  }

  /** Drop all named channels bound by a process (called on process death). */
  releaseByPid(pid: number): void {
    for (const [path, owner] of this.#registry) {
      if (owner === pid) this.#registry.delete(path);
    }
  }
}

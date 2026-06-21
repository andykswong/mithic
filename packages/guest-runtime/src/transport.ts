export interface Transport {
  send(msg: unknown, transfer?: Transferable[]): void;
  /**
   * Deliver an incoming message to the consumer. B5: the second argument carries
   * any MessagePorts transferred WITH that message (e.g. `fs/pipe`/`ipc/*` ends
   * the kernel transfers in a syscall response). Consumers that ignore it keep
   * working — the ports are simply dropped on the floor as before.
   */
  onMessage(cb: (msg: unknown, ports?: readonly MessagePort[]) => void): void;
  close(): void;
}

export class MessagePortTransport implements Transport {
  private port: MessagePort;
  constructor(port: MessagePort) { this.port = port; this.port.start?.(); }
  send(msg: unknown, transfer: Transferable[] = []): void { this.port.postMessage(msg, transfer); }
  onMessage(cb: (msg: unknown, ports?: readonly MessagePort[]) => void): void {
    this.port.onmessage = (e) => cb(e.data, e.ports && e.ports.length > 0 ? e.ports : undefined);
  }
  close(): void { this.port.close(); }
}

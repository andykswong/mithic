export interface Transport {
  send(msg: unknown, transfer?: Transferable[]): void;
  onMessage(cb: (msg: unknown) => void): void;
  close(): void;
}

export class MessagePortTransport implements Transport {
  constructor(private port: MessagePort) { this.port.start?.(); }
  send(msg: unknown, transfer: Transferable[] = []): void { this.port.postMessage(msg, transfer); }
  onMessage(cb: (msg: unknown) => void): void { this.port.onmessage = (e) => cb(e.data); }
  close(): void { this.port.close(); }
}

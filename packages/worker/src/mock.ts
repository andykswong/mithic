/**
 * Mock Worker for unit testing. Simulates the Web Worker message protocol
 * without spawning real threads. Messages are delivered asynchronously
 * (via queueMicrotask) to match real Worker timing semantics.
 */

type MessageHandler = ((e: MessageEvent) => void) | null;

export class MockWorker extends EventTarget {
  #onmessage: MessageHandler = null;
  #inner: MockWorkerInner;
  #terminated = false;

  get onmessage() { return this.#onmessage; }
  set onmessage(fn: MessageHandler) { this.#onmessage = fn; }

  constructor(handler: (inner: MockWorkerInner) => void) {
    super();
    this.#inner = new MockWorkerInner(this);
    queueMicrotask(() => handler(this.#inner));
  }

  postMessage(data: unknown, _transfer?: Transferable[]) {
    if (this.#terminated) return;
    queueMicrotask(() => {
      if (this.#terminated) return;
      this.#inner._deliver(data);
    });
  }

  terminate() {
    this.#terminated = true;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }

  _receiveFromInner(data: unknown) {
    if (this.#terminated) return;
    const event = new MessageEvent('message', { data });
    if (this.#onmessage) this.#onmessage(event);
    this.dispatchEvent(event);
  }

  _closeFromInner() {
    if (this.#terminated) return;
    this.#terminated = true;
    this.dispatchEvent(new Event('close'));
  }

  _errorFromInner(error: Error) {
    this.dispatchEvent(new ErrorEvent('error', { message: error.message, error }));
  }
}

export class MockWorkerInner {
  #outer: MockWorker;
  #onmessage: MessageHandler = null;

  get onmessage() { return this.#onmessage; }
  set onmessage(fn: MessageHandler) { this.#onmessage = fn; }

  constructor(outer: MockWorker) {
    this.#outer = outer;
  }

  postMessage(data: unknown, _transfer?: Transferable[]) {
    queueMicrotask(() => this.#outer._receiveFromInner(data));
  }

  close() {
    queueMicrotask(() => this.#outer._closeFromInner());
  }

  _deliver(data: unknown) {
    const event = new MessageEvent('message', { data });
    if (this.#onmessage) this.#onmessage(event);
  }
}

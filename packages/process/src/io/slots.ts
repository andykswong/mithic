export interface ExitSlot {
  readonly buffer: SharedArrayBuffer;
  tryWait(): number | undefined;
  wait(): number;
  setExitCode(code: number): void;
}

export interface SignalSlot {
  readonly buffer: SharedArrayBuffer;
  pending(): number;
  send(signal: number): void;
  consume(): number;
}

export function createExitSlot(): ExitSlot {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.store(view, 0, -1); // -1 = not exited

  return {
    buffer,
    tryWait(): number | undefined {
      const code = Atomics.load(view, 0);
      return code === -1 ? undefined : code;
    },
    wait(): number {
      while (Atomics.load(view, 0) === -1) {
        Atomics.wait(view, 0, -1);
      }
      return Atomics.load(view, 0);
    },
    setExitCode(code: number): void {
      Atomics.store(view, 0, code);
      Atomics.notify(view, 0);
    },
  };
}

export function createSignalSlot(): SignalSlot {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.store(view, 0, 0); // 0 = no signal

  return {
    buffer,
    pending(): number { return Atomics.load(view, 0); },
    send(signal: number): void {
      Atomics.store(view, 0, signal);
      Atomics.notify(view, 0);
    },
    consume(): number { return Atomics.exchange(view, 0, 0); },
  };
}

export function exitSlotFromBuffer(buffer: SharedArrayBuffer): ExitSlot {
  const view = new Int32Array(buffer);
  return {
    buffer,
    tryWait(): number | undefined {
      const code = Atomics.load(view, 0);
      return code === -1 ? undefined : code;
    },
    wait(): number {
      while (Atomics.load(view, 0) === -1) {
        Atomics.wait(view, 0, -1);
      }
      return Atomics.load(view, 0);
    },
    setExitCode(code: number): void {
      Atomics.store(view, 0, code);
      Atomics.notify(view, 0);
    },
  };
}

export function signalSlotFromBuffer(buffer: SharedArrayBuffer): SignalSlot {
  const view = new Int32Array(buffer);
  return {
    buffer,
    pending(): number { return Atomics.load(view, 0); },
    send(signal: number): void {
      Atomics.store(view, 0, signal);
      Atomics.notify(view, 0);
    },
    consume(): number { return Atomics.exchange(view, 0, 0); },
  };
}

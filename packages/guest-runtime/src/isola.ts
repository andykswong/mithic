import type { ProcessInit } from '@mithic/protocol';
import { isKernelEvent } from '@mithic/protocol';
import { SyscallClient } from './syscall-client.ts';
import { portToReadable, portToWritable } from './streams.ts';
import type { Transport } from './transport.ts';

export interface GuestOptions {
  control: MessagePort;
  init: ProcessInit;
  preopenPorts?: Record<number, MessagePort>;
}

/**
 * A DOM event forwarded from the host (a user interaction on a mirrored
 * element) to the guest. Mirrors the host's `GuestDomEvent` shape.
 */
export interface GuestDomEventPayload {
  /** Virtual DOM node id of the target element. */
  nodeId: number;
  /** Event type (e.g. "click", "input"). */
  eventType: string;
  /** Event-specific payload (e.g. `{ value }` for input events). */
  payload?: Record<string, unknown>;
}

export interface Guest {
  pid: number;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  syscall(call: string, args: Record<string, unknown>): Promise<unknown>;
  onSignal(cb: (signal: string, payload?: unknown) => void): void;
  /**
   * Subscribe to `dom/event` kernel events forwarded from the host (clicks,
   * input, etc. on mirrored Remote DOM elements). The guest's remote-dom layer
   * wires this to dispatch the event to the matching VNode listener.
   * Optional so lightweight stub guests (e.g. unit tests that only serialize
   * mutations) need not implement it.
   */
  onDomEvent?(cb: (event: GuestDomEventPayload) => void): void;
  exit(code: number): void;
}

export function createGuest({ control, init, preopenPorts = {} }: GuestOptions): Guest {
  const signalListeners: Array<(signal: string, payload?: unknown) => void> = [];
  const domEventListeners: Array<(event: GuestDomEventPayload) => void> = [];
  const responseListeners: Array<(msg: unknown) => void> = [];

  // Multiplex the control port: route syscall responses vs kernel events
  control.start?.();
  control.onmessage = (e: MessageEvent) => {
    const msg = e.data as unknown;
    if (isKernelEvent(msg)) {
      if (msg.event === 'signal') {
        const payload = msg.payload as { signal?: string; extra?: unknown } | undefined;
        for (const cb of signalListeners) {
          cb(payload?.signal ?? '', payload?.extra);
        }
      } else if (msg.event === 'dom/event') {
        const p = msg.payload as Partial<GuestDomEventPayload> | undefined;
        if (p && typeof p.nodeId === 'number' && typeof p.eventType === 'string') {
          const event: GuestDomEventPayload = {
            nodeId: p.nodeId,
            eventType: p.eventType,
            payload: p.payload ?? {},
          };
          for (const cb of domEventListeners) cb(event);
        }
      }
    } else {
      for (const cb of responseListeners) cb(msg);
    }
  };

  // Build a transport that routes to/from our multiplexer
  const transport: Transport = {
    send(msg, transfer = []) { control.postMessage(msg, transfer as Transferable[]); },
    onMessage(cb) { responseListeners.push(cb); },
    close() { control.close(); },
  };

  const client = new SyscallClient(transport);

  // Build stdio streams from preopen ports
  const stdinPort = preopenPorts[0];
  const stdoutPort = preopenPorts[1];
  const stderrPort = preopenPorts[2];

  const stdin = stdinPort ? portToReadable(stdinPort) : new ReadableStream<Uint8Array>();
  const stdout = stdoutPort ? portToWritable(stdoutPort) : new WritableStream<Uint8Array>();
  const stderr = stderrPort ? portToWritable(stderrPort) : new WritableStream<Uint8Array>();

  return {
    pid: init.pid,
    args: init.args,
    env: init.env,
    cwd: init.cwd,
    stdin,
    stdout,
    stderr,
    syscall: (call, args) => client.syscall(call, args),
    onSignal(cb) { signalListeners.push(cb); },
    onDomEvent(cb) { domEventListeners.push(cb); },
    exit(code) {
      control.postMessage({ type: 'exit', code });
      // Close the client: rejects any in-flight syscalls and closes the transport.
      client.close();
    },
  };
}

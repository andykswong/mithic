import type { ProcessInit } from '@mithic/protocol';
import { isKernelEvent } from '@mithic/protocol';
import { SyscallClient } from './syscall-client.ts';
import type { SyscallCallOptions, SyscallResult } from './syscall-client.ts';
import { portToReadable, portToWritable, portToDuplex } from './streams.ts';
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
  syscall(call: string, args: Record<string, unknown>, opts?: SyscallCallOptions): Promise<unknown>;
  /**
   * B5: like {@link syscall} but also surfaces any MessagePorts the kernel
   * transferred with the response. Use for `fs/pipe`/`ipc/connect`/`ipc/accept`.
   */
  syscallPorts(call: string, args: Record<string, unknown>, opts?: SyscallCallOptions): Promise<SyscallResult>;
  /**
   * B5: mint a kernel pipe and receive its read/write ends as live WHATWG
   * streams (over the transferred MessagePorts). Resolves to the integer fds
   * (`readfd`/`writefd`) the kernel registered plus the adapted streams. On
   * relay (non-transferable) backends no ports arrive — `readable`/`writable`
   * are `undefined` and the caller must fall back to the integer fds.
   */
  pipe(): Promise<{ readfd: number; writefd: number; readable?: ReadableStream<Uint8Array>; writable?: WritableStream<Uint8Array> }>;
  /**
   * B5: connect to a listening IPC path and receive the duplex connection as a
   * `{ readable, writable }` pair over the transferred port (or `connfd` only on
   * relay backends).
   */
  connect(path: string): Promise<{ connfd: number; readable?: ReadableStream<Uint8Array>; writable?: WritableStream<Uint8Array> }>;
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
  // B5: response listeners now also receive any MessagePorts the kernel
  // transferred with the response (e.g. the fs/pipe / ipc/* ends).
  const responseListeners: Array<(msg: unknown, ports?: readonly MessagePort[]) => void> = [];

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
      // B5: forward transferred ports (if any) so the SyscallClient can surface
      // them alongside the response result.
      const ports = e.ports && e.ports.length > 0 ? e.ports : undefined;
      for (const cb of responseListeners) cb(msg, ports);
    }
  };

  // Build a transport that routes to/from our multiplexer
  const transport: Transport = {
    send(msg, transfer = []) { control.postMessage(msg, transfer as Transferable[]); },
    onMessage(cb) { responseListeners.push(cb); },
    close() { control.close(); },
  };

  const client = new SyscallClient(transport);

  // Build stdio streams from preopen ports.
  // When a port is absent the fd is intentionally /dev/null-like:
  //   stdin  → an immediately-closed ReadableStream (yields EOF on first read).
  //   stdout/stderr → a null-sink WritableStream whose write() is a no-op,
  //     analogous to writing to a closed/detached fd. This is intentional —
  //     guest code that writes to stdout/stderr when those fds are not wired
  //     (e.g. headless processes that only use syscalls) should not throw.
  const nullSink = (): WritableStream<Uint8Array> =>
    new WritableStream<Uint8Array>({ write() { /* /dev/null — intentional discard */ } });

  const stdinPort = preopenPorts[0];
  const stdoutPort = preopenPorts[1];
  const stderrPort = preopenPorts[2];

  const stdin = stdinPort ? portToReadable(stdinPort) : new ReadableStream<Uint8Array>();
  const stdout = stdoutPort ? portToWritable(stdoutPort) : nullSink();
  const stderr = stderrPort ? portToWritable(stderrPort) : nullSink();

  // Seam 2: track whether stdin's read-side has already signalled closure, so
  // `exit()` does not double-post.
  let stdinClosed = false;

  /**
   * Tear down the stdin READ side on process exit: post an EPIPE up the pipe and
   * close the port, so the UPSTREAM producer (the previous pipeline stage writing
   * into our stdin) sees a broken pipe and stops — instead of blocking forever
   * filling a pipe whose only reader has gone away (`yes | head -n3`).
   *
   * Mirrors POSIX: when a process exits the OS closes the read end of its stdin
   * pipe and the writer gets EPIPE/SIGPIPE. We can only do this guest-side: the
   * stdin MessagePort was TRANSFERRED into this guest, so the kernel no longer
   * holds it and cannot post to its peer. We post directly to the entangled peer
   * (the producer's write port) via this port. The kernel's `#exit` complements
   * this for INJECTED write ports (downstream EOF); together they tear down both
   * directions of a dying stage's pipes.
   */
  function closeStdinPeer(): void {
    if (stdinClosed || !stdinPort) return;
    stdinClosed = true;
    try {
      stdinPort.postMessage({ type: 'error', code: 'EPIPE' });
      stdinPort.close();
    } catch {
      // Port already neutered/closed (e.g. stdin reached EOF and portToReadable
      // closed it, or the stream was cancelled). Nothing to signal.
    }
  }

  return {
    pid: init.pid,
    args: init.args,
    env: init.env,
    cwd: init.cwd,
    stdin,
    stdout,
    stderr,
    syscall: (call, args, opts) => client.syscall(call, args, opts),
    syscallPorts: (call, args, opts) => client.syscallPorts(call, args, opts),
    async pipe() {
      const { result, ports } = await client.syscallPorts('fs/pipe', {});
      const r = result as { readfd: number; writefd: number };
      // Transferable backends: two ports arrive — readPort then writePort.
      // Relay backends transfer nothing; surface the integer fds only.
      const readPort = ports[0];
      const writePort = ports[1];
      return {
        readfd: r.readfd,
        writefd: r.writefd,
        readable: readPort ? portToReadable(readPort) : undefined,
        writable: writePort ? portToWritable(writePort) : undefined,
      };
    },
    async connect(path) {
      const { result, ports } = await client.syscallPorts('ipc/connect', { path });
      const r = result as { connfd: number };
      const port = ports[0];
      if (!port) return { connfd: r.connfd };
      const { readable, writable } = portToDuplex(port);
      return { connfd: r.connfd, readable, writable };
    },
    onSignal(cb) { signalListeners.push(cb); },
    onDomEvent(cb) { domEventListeners.push(cb); },
    exit(code) {
      // Break the stdin pipe so an unconsumed upstream producer gets EPIPE.
      closeStdinPeer();
      control.postMessage({ type: 'exit', code });
      // Close the client: rejects any in-flight syscalls and closes the transport.
      client.close();
    },
  };
}

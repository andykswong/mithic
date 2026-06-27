import type { DisplayInfo, ProcessInit } from '@mithic/protocol';
import { isKernelEvent } from '@mithic/protocol';
import { SyscallClient } from './syscall-client.ts';
import type { SyscallCallOptions, SyscallResult } from './syscall-client.ts';
import { portToReadable, portToWritable, portToDuplex } from './streams.ts';
import type { Transport } from './transport.ts';
import { createFetch } from './fetch.ts';
import { openRoot } from './fs-access.ts';
import type { GuestDirectoryHandle } from './fs-access.ts';

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
  /**
   * B2/B6: a capability-scoped standard `fetch(input, init): Promise<Response>`
   * layered over the `net/fetch` syscall. Guest code depends on the WHATWG
   * `fetch`/`Request`/`Response` interfaces; the integer-free arg-bag is hidden.
   * `init.signal` is threaded through to the syscall (B1). On a transferable
   * backend `Response.body` is a live `ReadableStream` over the transferred port
   * (B6 streaming); on a relay backend it is the materialized bytes. Aborting
   * `init.signal` cancels an in-flight streamed body.
   */
  fetch: typeof fetch;
  /**
   * B3: the VFS root as a standard `FileSystemDirectoryHandle`-shaped handle,
   * layered over the `fs/*` syscalls. Guest code depends on the WHATWG File
   * System Access API (`getFileHandle`/`getDirectoryHandle`/`getFile`/
   * `createWritable`/`keys`/`values`/`entries`); the integer fd stays internal.
   * A getter so the handle is minted on first use only.
   */
  readonly fs: GuestDirectoryHandle;
  /**
   * Subscribe to EVERY kernel signal. This is the MULTI-SHOT primitive: a
   * repeatable signal (e.g. SIGUSR1/SIGUSR2) fires the callback each time, which
   * is what the shell needs to route every signal to its traps. Do NOT model the
   * signal channel on {@link signal} — an `AbortSignal` is one-shot.
   */
  onSignal(cb: (signal: string, payload?: unknown) => void): void;
  /**
   * B4: a DERIVED CONVENIENCE `AbortSignal` that aborts on a TERMINAL signal
   * (SIGTERM/SIGINT). One-shot by nature — it is a view over the terminal subset
   * only, NOT a replacement for {@link onSignal}. Pass it to `fetch`/aborting
   * APIs so in-flight work unwinds when the process is asked to terminate. Its
   * `reason` is a DOMException naming the terminal signal.
   */
  readonly signal: AbortSignal;
  /**
   * Subscribe to `dom/event` kernel events forwarded from the host (clicks,
   * input, etc. on mirrored Remote DOM elements). The guest's remote-dom layer
   * wires this to dispatch the event to the matching VNode listener.
   * Optional so lightweight stub guests (e.g. unit tests that only serialize
   * mutations) need not implement it.
   */
  onDomEvent?(cb: (event: GuestDomEventPayload) => void): void;
  /**
   * POSIX `isatty`: true if fd (0/1/2) is connected to an interactive terminal
   * rather than a plain pipe/redirect. Read from `init.preopens[fd].tty`. Use it
   * to decide whether to colorize output, show an interactive prompt, or run in
   * batch mode. Returns false for any fd without a tty preopen (incl. unknown fds).
   */
  isatty(fd: number): boolean;
  /**
   * The GUI surface this process was given at boot (from the app manifest's
   * display config, threaded by the host). `undefined` or `available:false`
   * means there is NO usable display (server/Node host, or spawned hidden) — the
   * app should run headless/CLI. When `available:true`, `width`/`height` are the
   * actual pixel size the host allocated. The guest LEARNS this; it cannot request
   * a window (geometry is the host/manifest's decision).
   */
  readonly display?: DisplayInfo;
  exit(code: number): void;
}

/** Terminal signals over which {@link Guest.signal} aborts (one-shot subset). */
const TERMINAL_SIGNALS: ReadonlySet<string> = new Set(['SIGTERM', 'SIGINT']);

export function createGuest({ control, init, preopenPorts = {} }: GuestOptions): Guest {
  const signalListeners: Array<(signal: string, payload?: unknown) => void> = [];
  const domEventListeners: Array<(event: GuestDomEventPayload) => void> = [];
  // B5: response listeners now also receive any MessagePorts the kernel
  // transferred with the response (e.g. the fs/pipe / ipc/* ends).
  const responseListeners: Array<(msg: unknown, ports?: readonly MessagePort[]) => void> = [];

  // B4: the derived terminal-only AbortSignal. `onSignal` stays the multi-shot
  // primitive below; this controller aborts ONCE, on the first terminal signal.
  const terminalAbort = new AbortController();

  // Multiplex the control port: route syscall responses vs kernel events
  control.start?.();
  control.onmessage = (e: MessageEvent) => {
    const msg = e.data as unknown;
    if (isKernelEvent(msg)) {
      if (msg.event === 'signal') {
        const payload = msg.payload as { signal?: string; extra?: unknown } | undefined;
        const sig = payload?.signal ?? '';
        // Multi-shot: every signal reaches every onSignal listener (incl. repeats).
        for (const cb of signalListeners) {
          cb(sig, payload?.extra);
        }
        // Derived one-shot: a TERMINAL signal aborts guest.signal exactly once.
        if (TERMINAL_SIGNALS.has(sig) && !terminalAbort.signal.aborted) {
          terminalAbort.abort(new DOMException(`terminated by ${sig}`, 'AbortError'));
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

  // B3: the File System Access root handle, minted lazily on first `guest.fs` use.
  let fsRoot: GuestDirectoryHandle | undefined;

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
    // B6: the fetch façade is ports-aware — it receives the transferred read
    // port for a streamed body via syscallPorts (and buffers when none arrives).
    fetch: createFetch((call, args, opts) => client.syscallPorts(call, args, opts)),
    get fs() { return fsRoot ??= openRoot((call, args, opts) => client.syscall(call, args, opts)); },
    onSignal(cb) { signalListeners.push(cb); },
    signal: terminalAbort.signal,
    onDomEvent(cb) { domEventListeners.push(cb); },
    isatty(fd: number) {
      return init.preopens?.[fd]?.tty === true;
    },
    display: init.display,
    exit(code) {
      // Break the stdin pipe so an unconsumed upstream producer gets EPIPE.
      closeStdinPeer();
      control.postMessage({ type: 'exit', code });
      // Close the client: rejects any in-flight syscalls and closes the transport.
      client.close();
    },
  };
}

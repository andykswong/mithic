import { INITIAL_CREDIT_BYTES } from './pipe.ts';

/**
 * C1: the ONE canonical credit-based pipe flow-control primitive, shared by all
 * six former hand-rolled consumers (`portToReadable`/`portToWritable` in
 * guest-runtime, and the kernel's `#feedFileToPort`, `#drainPortToFile`,
 * `#drainPort`, `feedPort`, and `RelayEnd`).
 *
 * It lives in `@mithic/protocol` — the package that already owns `PipeMessage`
 * and the credit constants and that BOTH the kernel and guest-runtime depend on
 * at runtime. (Putting it in guest-runtime would invert the intended layering:
 * the kernel only devDeps guest-runtime.)
 *
 * SCOPE: these classes own ONLY the flow-control INVARIANT — the credit window,
 * the sticky-broken latch, and FIFO waiter wakeup. They do NOT own the
 * MessagePort or perform any `postMessage`. Each consumer keeps its own
 * transport/buffering/enqueue logic and drives the primitive with the events it
 * observes (`addCredit` on a `credit` message, `markBroken` on `end`/`error`,
 * `recordArrival` on a `data` message) and asks it for decisions (`reserve` a
 * write, how much to `replenish`). This keeps the invariant in one place while
 * the wildly different surfaces (WHATWG streams, fire-and-forget pumps, a
 * pull-based byte API) layer cleanly on top.
 *
 * ── Canonical window policy ──────────────────────────────────────────────────
 * The replenish ALGORITHM is one and the same everywhere: open a fixed window of
 * credit on first demand, then replenish only the bytes the consumer has
 * actually drained (capped so outstanding credit never exceeds the window). The
 * default window SIZE is {@link INITIAL_CREDIT_BYTES} (64 KiB) — the smallest
 * window that still gives good throughput over a single postMessage hop while
 * keeping back-pressure promptly observable (a fast producer to a slow consumer
 * stalls before buffering a megabyte). It is also the value the guest stdio side
 * already used and the browser back-pressure tests pin, so promoting it to THE
 * default is the least surprising choice.
 *
 * Consumers that legitimately need a larger window pass one explicitly:
 *   - the capture-path drain uses 16 MiB so a single large chunk flows without a
 *     per-chunk-exceeds-window deadlock (a writer parks for the WHOLE chunk size;
 *     the window must be ≥ the largest chunk it sends);
 *   - the file/relay paths use 1 MiB as a throughput middle ground.
 * The window is therefore parameterized, but the policy (open-once + drain-based
 * replenish) is singular.
 */

/** A parked writer waiting for enough credit to send `needed` bytes. */
interface CreditWaiter {
  needed: number;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * Write-side flow control: tracks credit granted by the peer reader, parks a
 * writer until enough credit is available (`reserve`), and owns the STICKY
 * broken-pipe latch. Once {@link markBroken} fires (the reader cancelled / the
 * peer sent EPIPE), EVERY parked waiter rejects at once AND every subsequent
 * `reserve` rejects immediately — even when credit is still available. This
 * closes the two races that hung an unbounded producer like `yes | head`: a
 * write that does not park (credit available) posting to a dead peer forever,
 * and a write that parks AFTER the EPIPE landed waiting for credit that never
 * comes. The sticky latch previously lived ONLY in the guest writer; unifying it
 * here gives the kernel writers the same protection.
 */
export class PipeWriter {
  #credit = 0;
  #waiters: CreditWaiter[] = [];
  #broken: { code: string } | undefined;

  /** Credit currently available to send (peer-granted, not yet consumed). */
  get credit(): number {
    return this.#credit;
  }

  /** The sticky broken-pipe state once latched, else undefined. */
  get broken(): { code: string } | undefined {
    return this.#broken;
  }

  /** The broken-pipe Error to reject writes with (carries `.code`). */
  brokenError(): Error & { code: string } {
    const code = this.#broken?.code ?? 'EPIPE';
    return Object.assign(new Error(code), { code });
  }

  /**
   * Add `bytes` of peer-granted credit and wake parked writers whose need is now
   * satisfied, in FIFO order. No-op once broken.
   */
  addCredit(bytes: number): void {
    if (this.#broken) return;
    this.#credit += bytes;
    while (this.#waiters.length > 0 && this.#credit >= this.#waiters[0].needed) {
      this.#waiters.shift()!.resolve();
    }
  }

  /**
   * Latch the STICKY broken flag (first code wins). Reject all parked waiters at
   * once; subsequent `reserve` calls reject immediately via the sticky check.
   */
  markBroken(code: string): void {
    if (this.#broken) return;
    this.#broken = { code };
    const err = this.brokenError();
    const waiters = this.#waiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  /**
   * Reserve `bytes` of credit to send. Resolves once enough credit is available
   * (deducting it), or rejects IMMEDIATELY if the pipe is (or becomes) broken.
   * A successful resolve means the caller may now post the bytes.
   */
  reserve(bytes: number): Promise<void> {
    if (this.#broken) return Promise.reject(this.brokenError());
    if (this.#credit >= bytes) {
      this.#credit -= bytes;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.#waiters.push({
        needed: bytes,
        resolve: () => { this.#credit -= bytes; resolve(); },
        reject,
      });
    });
  }
}

/**
 * Read-side flow control: the canonical sliding credit window. `open()` grants
 * the full window once on first demand; `recordArrival(bytes)` accounts for a
 * `data` chunk landing (it consumes outstanding credit); `replenish()` returns
 * how much credit to grant back — only the bytes the consumer has actually
 * drained since the last grant, capped so outstanding never exceeds the window.
 * A slow consumer that stops draining replenishes nothing, the writer exhausts
 * its credit, and back-pressure kicks in.
 *
 * The class does NOT post credit — the consumer takes the returned byte counts
 * and posts `{type:'credit', bytes}` itself (it owns the port).
 */
export class PipeReader {
  readonly #window: number;
  /** Credit granted to the writer but not yet consumed by an arrival. */
  #outstanding = 0;
  /** Bytes that arrived and were drained but not yet credited back. */
  #consumedUncredited = 0;
  #opened = false;

  constructor(window: number = INITIAL_CREDIT_BYTES) {
    this.#window = window;
  }

  /** The configured credit window size in bytes. */
  get window(): number {
    return this.#window;
  }

  /** Outstanding (granted, not-yet-arrived) credit. */
  get outstanding(): number {
    return this.#outstanding;
  }

  /**
   * Open the window on first demand: grants the full window and returns it (the
   * consumer posts it). Idempotent — a second call grants 0.
   */
  open(): number {
    if (this.#opened) return 0;
    this.#opened = true;
    this.#consumedUncredited = 0;
    this.#outstanding += this.#window;
    return this.#window;
  }

  /**
   * Account for an arrived `data` chunk of `bytes`: it consumed part of the
   * outstanding window, and counts toward what we will replenish on the next
   * demand once the consumer drains it.
   */
  recordArrival(bytes: number): void {
    this.#outstanding -= bytes;
    this.#consumedUncredited += bytes;
  }

  /**
   * Compute the next credit grant: only the drained bytes since the last grant,
   * capped so outstanding never exceeds the window. Returns the bytes to grant
   * (0 = nothing; the consumer skips posting). Updates internal accounting as if
   * the grant was posted.
   */
  replenish(): number {
    const room = this.#window - this.#outstanding;
    const grant = Math.min(this.#consumedUncredited, room);
    if (grant <= 0) return 0;
    this.#consumedUncredited -= grant;
    this.#outstanding += grant;
    return grant;
  }
}

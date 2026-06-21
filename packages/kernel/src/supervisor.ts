import type { KernelEvent, ProcessLimits, Signal } from '@mithic/protocol';
import { isTerminatingSignal, signalExitCode } from '@mithic/protocol';

/** K4: heartbeat/health-watchdog configuration (§8.2). */
export interface HeartbeatOptions {
  /** Ping interval in ms. Design default: 5000. */
  intervalMs: number;
  /** Consecutive missed acks before declaring the process hung. Design default: 3. */
  maxMissed: number;
}

/**
 * C3: the small kernel surface the {@link Supervisor} calls back into. Keeps the
 * Supervisor free of any direct knowledge of the Runtime/launcher/handles — it
 * owns only the timers and asks the kernel to act.
 */
export interface SupervisorHost {
  /** Is the process still alive (not DEAD / not reaped)? */
  isAlive(pid: number): boolean;
  /**
   * Hard-kill a process via the normal `Kernel.kill` path (SIGKILL → 137). Used by
   * the wall-clock watchdog and the heartbeat hung-detector.
   */
  kill(pid: number, signal: Signal): void;
  /**
   * Force the sandbox down and exit `pid` with `exitCode` WITHOUT re-delivering a
   * signal — the launcher/runtime teardown + `#exit(pid, exitCode)`. Used by the
   * terminating-signal grace timer to apply the 128+signum status if the guest
   * ignored the signal.
   */
  forceExit(pid: number, exitCode: number): void;
  /** Post a KernelEvent (e.g. `{event:'heartbeat'}`) to the guest. */
  postEvent(pid: number, event: KernelEvent): void;
}

/**
 * C3 — owns the kernel's per-process lifecycle timers, lifted out of the Kernel
 * god-object as a focused collaborator (the arm/clear Maps were already
 * self-contained). Three independent timer families:
 *
 *   - **Watchdog** (LIM-1): a wall-clock `limits.timeoutMs` timer that SIGKILLs an
 *     over-time process, backend-agnostic.
 *   - **Signal grace** (C1): a window armed after a TERMINATING signal is
 *     delivered; if the guest does not exit within it the kernel force-exits it
 *     with `128+signum`.
 *   - **Heartbeat** (K4 §8.2): an interval ping + missed-ack counter that declares
 *     an unresponsive guest hung and SIGKILLs it (137).
 *
 * Ordering preserved from the monolithic kernel: the Kernel still drives
 * `kill → #exit → clear` — `#exit` calls {@link clear} to cancel ALL of a pid's
 * timers up-front so none can fire after teardown or re-kill a recycled pid. The
 * grace timer arms inside `kill` (idempotent per pid) and force-exits via the host.
 */
export class Supervisor {
  #host: SupervisorHost;
  #signalGraceMs: number;
  #heartbeat: HeartbeatOptions | undefined;

  /**
   * LIM-1: per-process wall-clock timeout watchdog timers. Started on spawn when
   * `limits.timeoutMs` is set, cleared on exit. Backend-agnostic — the kernel
   * SIGKILLs an over-time process regardless of whether the runtime enforces
   * timeouts itself (Worker/iframe do not).
   */
  #watchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  /** C1: per-process grace-window timers armed after a terminating signal is delivered. */
  #signalGraceTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** K4: per-process heartbeat interval timers and missed-ack counters. */
  #heartbeatTimers = new Map<number, ReturnType<typeof setInterval>>();
  #heartbeatMissed = new Map<number, number>();

  constructor(host: SupervisorHost, signalGraceMs: number, heartbeat?: HeartbeatOptions) {
    this.#host = host;
    this.#signalGraceMs = signalGraceMs;
    this.#heartbeat = heartbeat;
  }

  /**
   * Arm a kernel-side wall-clock watchdog for `pid` if `limits.timeoutMs` is set.
   * On expiry, if the process is still alive, SIGKILL it — its `wait()` then
   * resolves with the SIGKILL exit status (137, nonzero). `unref()` (when
   * available) keeps the timer from holding the event loop open. Idempotent
   * per pid; cleared by {@link clear} on exit.
   */
  armWatchdog(pid: number, limits: ProcessLimits | undefined): void {
    const timeoutMs = limits?.timeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this.#watchdogs.delete(pid);
      if (this.#host.isAlive(pid)) {
        try { this.#host.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    this.#watchdogs.set(pid, timer);
  }

  /**
   * K4 (§8.2): arm the heartbeat watchdog for `pid` if heartbeat monitoring is
   * enabled. Every `intervalMs` the kernel posts `{event:'heartbeat'}` and counts
   * it as a missed ack until the guest replies `{type:'heartbeat-ack'}` (the
   * kernel calls {@link recordHeartbeatAck}, which resets the counter). After
   * `maxMissed` consecutive misses the process is declared hung and SIGKILLed (137).
   */
  armHeartbeat(pid: number): void {
    const hb = this.#heartbeat;
    if (!hb || hb.intervalMs <= 0) return;
    this.#heartbeatMissed.set(pid, 0);
    const timer = setInterval(() => {
      if (!this.#host.isAlive(pid)) { this.#clearHeartbeat(pid); return; }
      const missed = (this.#heartbeatMissed.get(pid) ?? 0) + 1;
      this.#heartbeatMissed.set(pid, missed);
      if (missed > hb.maxMissed) {
        // Declared hung: hard-kill (137). #exit (via kill→#exit→clear) clears the timer.
        this.#clearHeartbeat(pid);
        try { this.#host.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        return;
      }
      this.#host.postEvent(pid, { event: 'heartbeat' });
    }, hb.intervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.#heartbeatTimers.set(pid, timer);
  }

  /** K4: reset a pid's missed-ack counter on a `{type:'heartbeat-ack'}` reply. */
  recordHeartbeatAck(pid: number): void {
    this.#heartbeatMissed.set(pid, 0);
  }

  /**
   * C1: arm the terminating-signal grace window for `pid`. Called by `Kernel.kill`
   * AFTER it has delivered the `{event:'signal'}` KernelEvent for a TERMINATING
   * signal. If the guest exits on its own within the window, `#exit` → {@link clear}
   * cancels the timer and the guest reports its OWN code; otherwise this fires and
   * force-exits the guest with `128+signum` via the host. Idempotent per pid — a
   * second terminating signal while a window is pending is a no-op.
   */
  armSignalGrace(pid: number, signal: Signal): void {
    if (!isTerminatingSignal(signal)) return;
    if (this.#signalGraceTimers.has(pid)) return; // a grace window is already pending
    const forced = signalExitCode(signal);
    const timer = setTimeout(() => {
      this.#signalGraceTimers.delete(pid);
      if (!this.#host.isAlive(pid)) return;
      this.#host.forceExit(pid, forced);
    }, this.#signalGraceMs);
    (timer as { unref?: () => void }).unref?.();
    this.#signalGraceTimers.set(pid, timer);
  }

  /**
   * Cancel ALL of a pid's timers (watchdog, signal-grace, heartbeat) — called by
   * the kernel's `#exit` BEFORE teardown so no timer can fire after the process is
   * gone (or re-kill a recycled pid). Mirrors the original `#exit` clear order:
   * watchdog → signal-grace → heartbeat. The order is immaterial (the families are
   * independent) but is preserved for parity.
   */
  clear(pid: number): void {
    this.#clearWatchdog(pid);
    this.#clearSignalGrace(pid);
    this.#clearHeartbeat(pid);
  }

  /** Clear a process's timeout watchdog. */
  #clearWatchdog(pid: number): void {
    const timer = this.#watchdogs.get(pid);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#watchdogs.delete(pid);
    }
  }

  /** C1: cancel a pid's pending terminating-signal grace timer (e.g. it exited). */
  #clearSignalGrace(pid: number): void {
    const t = this.#signalGraceTimers.get(pid);
    if (t !== undefined) { clearTimeout(t); this.#signalGraceTimers.delete(pid); }
  }

  /** K4: cancel a pid's heartbeat monitor. */
  #clearHeartbeat(pid: number): void {
    const t = this.#heartbeatTimers.get(pid);
    if (t !== undefined) { clearInterval(t); this.#heartbeatTimers.delete(pid); }
    this.#heartbeatMissed.delete(pid);
  }
}

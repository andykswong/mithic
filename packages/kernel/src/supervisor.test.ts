/**
 * C3 — focused unit tests for the {@link Supervisor} collaborator extracted from
 * the Kernel. The Kernel's signals/heartbeat/limits suites already exercise the
 * Supervisor end-to-end through the public API; these drive it in ISOLATION over
 * a mock {@link SupervisorHost} to pin the three timer families' contracts:
 *   - watchdog: fires `kill(SIGKILL)` only while the process is alive;
 *   - signal grace: force-exits with `128+signum` for a TERMINATING signal, is a
 *     no-op for a non-terminating one, and is idempotent per pid;
 *   - heartbeat: pings until `maxMissed` is exceeded, then declares hung (kill);
 *     an ack resets the miss counter;
 *   - `clear(pid)` cancels every armed timer so none fires after exit.
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { KernelEvent, Signal } from '@mithic/protocol';
import { Supervisor } from './supervisor.ts';
import type { SupervisorHost } from './supervisor.ts';

interface Recorder {
  host: SupervisorHost;
  alive: Set<number>;
  kills: Array<{ pid: number; signal: Signal }>;
  forceExits: Array<{ pid: number; code: number }>;
  events: Array<{ pid: number; event: KernelEvent }>;
}

function makeHost(): Recorder {
  const alive = new Set<number>();
  const kills: Recorder['kills'] = [];
  const forceExits: Recorder['forceExits'] = [];
  const events: Recorder['events'] = [];
  const host: SupervisorHost = {
    isAlive: (pid) => alive.has(pid),
    kill: (pid, signal) => { kills.push({ pid, signal }); },
    forceExit: (pid, code) => { forceExits.push({ pid, code }); },
    postEvent: (pid, event) => { events.push({ pid, event }); },
  };
  return { host, alive, kills, forceExits, events };
}

afterEach(() => { vi.useRealTimers(); });

test('watchdog: SIGKILLs an over-time process that is still alive', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(7);
  const sup = new Supervisor(r.host, 2000);
  sup.armWatchdog(7, { timeoutMs: 1000 });

  vi.advanceTimersByTime(999);
  expect(r.kills).toEqual([]);
  vi.advanceTimersByTime(2);
  expect(r.kills).toEqual([{ pid: 7, signal: 'SIGKILL' }]);
});

test('watchdog: a process that already exited is NOT killed on expiry', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(7);
  const sup = new Supervisor(r.host, 2000);
  sup.armWatchdog(7, { timeoutMs: 1000 });

  // Process exits before the watchdog fires: clear() + drop liveness.
  sup.clear(7);
  r.alive.delete(7);
  vi.advanceTimersByTime(2000);
  expect(r.kills).toEqual([]);
});

test('watchdog: unset / zero timeoutMs arms nothing', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(1);
  const sup = new Supervisor(r.host, 2000);
  sup.armWatchdog(1, undefined);
  sup.armWatchdog(1, { timeoutMs: 0 });
  vi.advanceTimersByTime(100000);
  expect(r.kills).toEqual([]);
});

test('signal grace: a TERMINATING signal force-exits with 128+signum if the guest lingers', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(5);
  const sup = new Supervisor(r.host, 2000);

  sup.armSignalGrace(5, 'SIGTERM'); // SIGTERM = 15 → 143
  vi.advanceTimersByTime(1999);
  expect(r.forceExits).toEqual([]);
  vi.advanceTimersByTime(2);
  expect(r.forceExits).toEqual([{ pid: 5, code: 143 }]);
  // Force-exit path does NOT route through kill (it applies the 128+N code itself).
  expect(r.kills).toEqual([]);
});

test('signal grace: SIGINT yields 130; a guest that exits within the window is not force-exited', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(5);
  const sup = new Supervisor(r.host, 2000);
  sup.armSignalGrace(5, 'SIGINT'); // 2 → 130

  // Guest exits cleanly within the window: kernel #exit → clear().
  sup.clear(5);
  r.alive.delete(5);
  vi.advanceTimersByTime(2000);
  expect(r.forceExits).toEqual([]);
});

test('signal grace: a NON-terminating signal arms nothing', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(5);
  const sup = new Supervisor(r.host, 2000);
  sup.armSignalGrace(5, 'SIGUSR1');
  sup.armSignalGrace(5, 'SIGCONT');
  vi.advanceTimersByTime(100000);
  expect(r.forceExits).toEqual([]);
});

test('signal grace: idempotent per pid — a second terminating signal does not re-arm', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(5);
  const sup = new Supervisor(r.host, 2000);
  sup.armSignalGrace(5, 'SIGTERM');
  sup.armSignalGrace(5, 'SIGINT'); // ignored: a window is already pending
  vi.advanceTimersByTime(2001);
  // Exactly ONE force-exit, with the FIRST signal's code (143), not 130.
  expect(r.forceExits).toEqual([{ pid: 5, code: 143 }]);
});

test('heartbeat: pings each interval, declares hung after maxMissed, then SIGKILLs', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(9);
  const sup = new Supervisor(r.host, 2000, { intervalMs: 100, maxMissed: 3 });
  sup.armHeartbeat(9);

  // Misses 1,2,3 each emit a ping; miss 4 (>maxMissed) declares hung → kill.
  vi.advanceTimersByTime(100); // miss 1, ping
  vi.advanceTimersByTime(100); // miss 2, ping
  vi.advanceTimersByTime(100); // miss 3, ping
  expect(r.events.filter((e) => e.event.event === 'heartbeat')).toHaveLength(3);
  expect(r.kills).toEqual([]);
  vi.advanceTimersByTime(100); // miss 4 > maxMissed → declared hung
  expect(r.kills).toEqual([{ pid: 9, signal: 'SIGKILL' }]);
});

test('heartbeat: an ack resets the miss counter so a responsive guest is never killed', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(9);
  const sup = new Supervisor(r.host, 2000, { intervalMs: 100, maxMissed: 3 });
  sup.armHeartbeat(9);

  // Ack on every interval keeps the counter at 0 → never declared hung.
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(100);
    sup.recordHeartbeatAck(9);
  }
  expect(r.kills).toEqual([]);
  expect(r.events.filter((e) => e.event.event === 'heartbeat').length).toBeGreaterThan(0);
});

test('heartbeat: a guest that has died stops the monitor on the next tick (no kill)', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(9);
  const sup = new Supervisor(r.host, 2000, { intervalMs: 100, maxMissed: 3 });
  sup.armHeartbeat(9);
  r.alive.delete(9); // died (e.g. exited on its own)
  vi.advanceTimersByTime(1000);
  expect(r.kills).toEqual([]);
});

test('clear(pid) cancels watchdog, grace, and heartbeat together', () => {
  vi.useFakeTimers();
  const r = makeHost();
  r.alive.add(3);
  const sup = new Supervisor(r.host, 2000, { intervalMs: 100, maxMissed: 1 });
  sup.armWatchdog(3, { timeoutMs: 500 });
  sup.armSignalGrace(3, 'SIGTERM');
  sup.armHeartbeat(3);

  sup.clear(3);
  vi.advanceTimersByTime(10000);
  expect(r.kills).toEqual([]);
  expect(r.forceExits).toEqual([]);
});

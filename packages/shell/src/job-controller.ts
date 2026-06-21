/**
 * Job control (C4).
 *
 * Extracted from {@link Executor}: the job table plus `wait` / `wait %job` /
 * `wait -n` / `jobs` / `kill %job` / `disown`. The executor already routed these
 * through the `shellState()` adapter (`waitJob`/`waitAll`/`waitNext`/`removeJob`/
 * `killJob`), and `wait*` were nearly standalone — this gives the job table its
 * own owner. Signal delivery uses an injected `kill` callback (the kernel's
 * `kill(pid, signal)`), so the controller has no direct kernel dependency.
 *
 * Job model note: this runtime has no SIGSTOP/SIGCONT semantics — `bg` is a
 * documented no-op and a non-CONT/STOP signal terminates the job in the table.
 */
import type { Job } from './executor.ts';

/** Deliver a signal to a real kernel pid; absent on minimal mock backends. */
export type KillFn = ((pid: number, signal: string) => void) | undefined;

export class JobController {
  private jobs: Job[] = [];
  private nextJobId = 1;
  /** `$!` — the leader pid of the most recently backgrounded job (0 ⇒ none yet). */
  private lastBg = 0;
  private kill: KillFn;

  constructor(kill: KillFn) {
    this.kill = kill;
  }

  /** Update the `kill` delivery callback (the kernel may be swapped in tests). */
  setKill(kill: KillFn): void { this.kill = kill; }

  /** The live job table (shared by reference with the `jobs` builtin via shellState). */
  list(): Job[] { return this.jobs; }

  /** `$!` — most recently backgrounded leader pid. */
  lastBgPid(): number { return this.lastBg; }
  setLastBgPid(pid: number): void { this.lastBg = pid; }

  /** Allocate the next job id (for the synthetic-pid in-process bg path). */
  allocId(): number { return this.nextJobId++; }

  /** Register a new running job and return it (the caller wires pids + promise). */
  register(command: string, pids: number[] = []): Job {
    const job: Job = { id: this.allocId(), pids, command, state: 'running' };
    this.jobs.push(job);
    return job;
  }

  // ── wait ──────────────────────────────────────────────────────────────────

  async waitJob(spec?: number): Promise<number> {
    if (spec === undefined) return this.waitAll();
    // spec may be a pid or %jobid; find the matching job.
    const job = this.jobs.find((j) => j.pids.includes(spec) || j.id === spec);
    if (!job) return 0;
    if (job.promise) return (await job.promise) ?? 0;
    return job.exitCode ?? 0;
  }

  async waitAll(): Promise<number> {
    let last = 0;
    for (const job of this.jobs) {
      if (job.promise) last = (await job.promise) ?? 0;
    }
    return last;
  }

  /**
   * `wait -n` (G5): wait for the NEXT job to finish and return its exit code.
   * Each waited job is removed from the table so a subsequent `wait -n` advances
   * to the next one (bash reaps the job). Returns 127 when there are no jobs.
   */
  async waitNext(): Promise<number> {
    if (this.jobs.length === 0) return 127;
    const pending = this.jobs
      .map((job) => ({ job, p: job.promise }))
      .filter((e): e is { job: Job; p: Promise<number> } => e.p !== undefined);
    if (pending.length === 0) {
      // No async promise to await (e.g. already-resolved jobs) — reap the first.
      const reaped = this.jobs.shift()!;
      return reaped.exitCode ?? 0;
    }
    // Race: whichever job finishes first resolves, then reap it.
    const code = await Promise.race(pending.map((e) => e.p.then((c) => ({ job: e.job, c }))))
      .then((r) => { this.jobs = this.jobs.filter((j) => j !== r.job); return r.c ?? 0; });
    return code;
  }

  // ── disown / kill ───────────────────────────────────────────────────────────

  /** Remove a job from the table by spec (pid or %id). Returns false if not found. */
  remove(spec: number): boolean {
    const idx = this.jobs.findIndex((j) => j.id === spec || j.pids.includes(spec));
    if (idx < 0) return false;
    this.jobs.splice(idx, 1);
    return true;
  }

  /**
   * Send a signal to a job/pid (M14). `signal` arrives `SIG`-stripped (e.g.
   * 'TERM'); the kernel wants a `SIG`-prefixed name. When the kernel has no kill
   * method (minimal mock), the job table is still updated best-effort.
   * SIGCONT/SIGSTOP change run state without terminating; everything else
   * terminates the job in this runtime's job model. Returns false for no job.
   */
  killJob(spec: number, signal: string): boolean {
    const job = this.jobs.find((j) => j.id === spec || j.pids.includes(spec));
    if (!job) return false;
    if (this.kill) {
      const sig = signal.startsWith('SIG') ? signal : 'SIG' + signal;
      for (const pid of job.pids) {
        try { this.kill(pid, sig); } catch { /* already gone */ }
      }
    }
    if (signal === 'CONT') job.state = 'running';
    else if (signal === 'STOP' || signal === 'TSTP') job.state = 'stopped';
    else job.state = 'done';
    return true;
  }
}

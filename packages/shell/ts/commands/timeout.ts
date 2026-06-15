import type { ProcessManager, SpawnOptions } from '@mithic/process/types';
import { Pollable, poll } from '@mithic/wasip2/io/poll';
import type { InputStream, OutputStream } from '@mithic/wasip2/io/streams';

export function runTimeout(
  args: string[],
  manager: ProcessManager,
  options?: { stdin?: InputStream; stdout?: OutputStream; stderr?: OutputStream },
  writeError?: (msg: string) => void,
): number {
  if (args.length < 2) {
    writeError?.('timeout: missing operand\n');
    return 125;
  }

  const durationStr = args[0];
  const durationSecs = parseFloat(durationStr);
  if (isNaN(durationSecs) || durationSecs < 0) {
    writeError?.(`timeout: invalid time interval '${durationStr}'\n`);
    return 125;
  }

  const command = args[1];
  const cmdArgs = args.slice(1);

  const spawnOpts: SpawnOptions = {};
  if (options?.stdin) spawnOpts.stdin = options.stdin;
  if (options?.stdout) spawnOpts.stdout = options.stdout;
  if (options?.stderr) spawnOpts.stderr = options.stderr;

  let proc;
  try {
    proc = manager.spawn(command, cmdArgs, spawnOpts);
  } catch {
    return 127;
  }

  const timeoutMs = durationSecs * 1000;
  const deadline = performance.now() + timeoutMs;
  const procPollable = proc.subscribe();
  const buf = new Int32Array(new SharedArrayBuffer(4));
  const timerPollable = new Pollable(
    () => performance.now() >= deadline,
    (maxBlockMs?: number) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      const waitMs = maxBlockMs !== undefined ? Math.min(maxBlockMs, remaining) : remaining;
      Atomics.wait(buf, 0, 0, waitMs);
    },
    () => Math.max(0, deadline - performance.now()),
  );

  const ready = poll([procPollable, timerPollable]);
  if (ready instanceof Promise) {
    return 125;
  }

  if (ready.includes(0)) {
    const code = proc.tryWait();
    return code ?? 0;
  }

  proc.kill('sigterm');
  proc.wait();
  return 124;
}

export async function runTimeoutAsync(
  args: string[],
  manager: ProcessManager,
  options?: { stdin?: InputStream; stdout?: OutputStream; stderr?: OutputStream },
  writeError?: (msg: string) => void,
): Promise<number> {
  if (args.length < 2) {
    writeError?.('timeout: missing operand\n');
    return 125;
  }

  const durationStr = args[0];
  const durationSecs = parseFloat(durationStr);
  if (isNaN(durationSecs) || durationSecs < 0) {
    writeError?.(`timeout: invalid time interval '${durationStr}'\n`);
    return 125;
  }

  const command = args[1];
  const cmdArgs = args.slice(1);

  const spawnOpts: SpawnOptions = {};
  if (options?.stdin) spawnOpts.stdin = options.stdin;
  if (options?.stdout) spawnOpts.stdout = options.stdout;
  if (options?.stderr) spawnOpts.stderr = options.stderr;

  let proc;
  try {
    proc = manager.spawn(command, cmdArgs, spawnOpts);
  } catch {
    return 127;
  }

  const timeoutMs = durationSecs * 1000;
  const deadline = performance.now() + timeoutMs;
  const procPollable = proc.subscribe();
  const timerPollable = new Pollable(
    () => performance.now() >= deadline,
    () => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      return new Promise<void>(resolve => setTimeout(resolve, remaining));
    },
    () => Math.max(0, deadline - performance.now()),
  );

  const ready = await poll([procPollable, timerPollable]);

  if (ready.includes(0)) {
    const code = proc.tryWait();
    return code ?? 0;
  }

  proc.kill('sigterm');
  await proc.waitAsync();
  return 124;
}

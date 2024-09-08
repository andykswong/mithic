import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { runWorker } from '#io/tests/worker';
import { Io } from '../../io/index.ts';
import { StdLogger, Level, Logger } from '../logger.ts';
import { log } from '../logging.ts';

const decoder = new TextDecoder();
const CONTEXT = 'CXT';
const MESSAGE = 'MESSAGE123';

describe('log', () => {
  let worker: Worker;
  let logger: StdLogger;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    stdout = [];
    [worker, Io.provider] = runWorker();
    worker.stdout?.on('data', (chunk) => {
      stdout.push(decoder.decode(chunk));
    });
    stderr = [];
    worker.stderr?.on('data', (chunk) => {
      stderr.push(decoder.decode(chunk));
    });

    Logger.instance = logger = new StdLogger();
    Logger.level = Level.Trace;

    await delay(100);
  });

  afterEach(async () => {
    await worker?.terminate();
    jest.restoreAllMocks();
  });

  it.each([
    [Level.Trace], [Level.Debug], [Level.Info]
  ])('should log formatted %s message to stdout', async (level) => {
    log(level, CONTEXT, MESSAGE);

    await delay(100);
    expect(stdout).toEqual([logger.format(level, CONTEXT, MESSAGE)]);
    expect(stderr).toEqual([]);
  });

  it.each([
    [Level.Warn], [Level.Error], [Level.Critical]
  ])('should log formatted %s message to stderr', async (level) => {
    log(level, CONTEXT, MESSAGE);

    await delay(100);
    expect(stderr).toEqual([logger.format(level, CONTEXT, MESSAGE)]);
    expect(stdout).toEqual([]);
  });

  it('should not log below set level', async () => {
    Logger.level = Level.Debug;
    log(Level.Trace, CONTEXT, MESSAGE);

    await delay(100);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });
});

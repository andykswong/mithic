import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { delay } from '@mithic/commons';
import { runWorker } from '../test/io.worker.ts';
import { Io } from '../io/index.ts';
import { StdLogger, Level, Logger } from './index.ts';
import { log } from './logging.ts';

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
    mock.restoreAll();
  });

  for (const [level] of [
    [Level.Trace], [Level.Debug], [Level.Info]
  ] as const) {
    it('should log formatted message to stdout', async () => {
      log(level, CONTEXT, MESSAGE);

      await delay(100);
      assert.deepStrictEqual(stdout, [logger.format(level, CONTEXT, MESSAGE)]);
      assert.deepStrictEqual(stderr, []);
    });
  }

  for (const [level] of [
    [Level.Warn], [Level.Error], [Level.Critical]
  ] as const) {
    it('should log formatted error message to stderr', async () => {
      log(level, CONTEXT, MESSAGE);

      await delay(100);
      assert.deepStrictEqual(stderr, [logger.format(level, CONTEXT, MESSAGE)]);
      assert.deepStrictEqual(stdout, []);
    });
  }

  it('should not log below set level', async () => {
    Logger.level = Level.Debug;
    log(Level.Trace, CONTEXT, MESSAGE);

    await delay(100);
    assert.deepStrictEqual(stdout, []);
    assert.deepStrictEqual(stderr, []);
  });
});

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { delay } from '@mithic/commons';
import { WebWriteStream } from '../index.ts';
import { StdLogger, Level, Logger } from './index.ts';
import { log } from './logging.ts';

const decoder = new TextDecoder();
const CONTEXT = 'CXT';
const MESSAGE = 'MESSAGE123';

describe('log', () => {
  let logger: StdLogger;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];

    Logger.instance = logger = new StdLogger(
      new WebWriteStream(new WritableStream({
        write(chunk) {
          stdout.push(decoder.decode(chunk));
        }
      })),
      new WebWriteStream(new WritableStream({
        write(chunk) {
          stderr.push(decoder.decode(chunk));
        }
      })),
    );
    Logger.level = Level.Trace;
  });

  afterEach(() => {
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

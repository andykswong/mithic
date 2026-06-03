import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InlineProcessWorker } from './inline-worker.ts';
import { createExitSlot } from '../io/slots.ts';
import { createSharedPipeRaw } from '../io/pipes.ts';
import { createSignalSlot } from '../io/slots.ts';
import type { RunOptions } from '../types.ts';

function createTestRunOptions(): RunOptions {
  const exitSlot = createExitSlot();
  const signalSlot = createSignalSlot();
  const stdin = createSharedPipeRaw(1024);
  const stdout = createSharedPipeRaw(1024);
  const stderr = createSharedPipeRaw(1024);
  return {
    args: ['test'],
    env: {},
    cwd: '/',
    exitSlotBuf: exitSlot.buffer,
    signalSlotBuf: signalSlot.buffer,
    stdinBuf: stdin.buffer,
    stdinBufSize: stdin.bufferSize,
    stdoutBuf: stdout.buffer,
    stdoutBufSize: stdout.bufferSize,
    stderrBuf: stderr.buffer,
    stderrBufSize: stderr.bufferSize,
  };
}

describe('InlineProcessWorker', () => {
  it('runs sync handler and sets exit code', async () => {
    const pw = new InlineProcessWorker(() => 42);
    const opts = createTestRunOptions();
    let closed = false;
    pw.addEventListener('close', () => { closed = true; });
    pw.run(opts, []);
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(closed, true);
    const view = new Int32Array(opts.exitSlotBuf);
    assert.strictEqual(Atomics.load(view, 0), 42);
  });

  it('runs async handler', async () => {
    const pw = new InlineProcessWorker(async () => { await new Promise(r => setTimeout(r, 5)); return 7; });
    const opts = createTestRunOptions();
    let closed = false;
    pw.addEventListener('close', () => { closed = true; });
    pw.run(opts, []);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(closed, true);
    const view = new Int32Array(opts.exitSlotBuf);
    assert.strictEqual(Atomics.load(view, 0), 7);
  });

  it('sets exit code 1 on handler error', async () => {
    const pw = new InlineProcessWorker(() => { throw new Error('fail'); });
    const opts = createTestRunOptions();
    let closed = false;
    pw.addEventListener('close', () => { closed = true; });
    pw.run(opts, []);
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(closed, true);
    const view = new Int32Array(opts.exitSlotBuf);
    assert.strictEqual(Atomics.load(view, 0), 1);
  });

  it('terminate is a no-op', () => {
    const pw = new InlineProcessWorker(() => 0);
    pw.terminate(); // should not throw
  });
});

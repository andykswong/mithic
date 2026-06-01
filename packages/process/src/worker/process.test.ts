import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleRunMessage, type RunMessage } from './process.ts';
import { createExitSlot, createSignalSlot } from '../io/slots.ts';
import { createSharedPipeRaw } from '../io/pipes.ts';

function createTestMessage(overrides?: Partial<RunMessage>): RunMessage {
  const exitSlot = createExitSlot();
  const signalSlot = createSignalSlot();
  const stdinPipe = createSharedPipeRaw(256);
  const stdoutPipe = createSharedPipeRaw(4096);
  const stderrPipe = createSharedPipeRaw(4096);

  return {
    type: 'run',
    compileResult: { modules: {}, jsFiles: {}, cached: false },
    args: ['test'],
    env: {},
    cwd: '/',
    exitSlotBuf: exitSlot.buffer,
    signalSlotBuf: signalSlot.buffer,
    stdinBuf: stdinPipe.buffer,
    stdinBufSize: stdinPipe.bufferSize,
    stdoutBuf: stdoutPipe.buffer,
    stdoutBufSize: stdoutPipe.bufferSize,
    stderrBuf: stderrPipe.buffer,
    stderrBufSize: stderrPipe.bufferSize,
    ...overrides,
  };
}

describe('handleRunMessage', () => {
  it('sets exit code 126 when jsFiles missing component.js', async () => {
    const msg = createTestMessage({
      compileResult: { modules: {}, jsFiles: {}, cached: false },
    });
    await handleRunMessage(msg);
    const view = new Int32Array(msg.exitSlotBuf);
    assert.equal(Atomics.load(view, 0), 126);
  });

  it('sets exit code 126 when jsFiles is undefined', async () => {
    const msg = createTestMessage({
      compileResult: { modules: {}, jsFiles: undefined as unknown as Record<string, string>, cached: false },
    });
    await handleRunMessage(msg);
    const view = new Int32Array(msg.exitSlotBuf);
    assert.equal(Atomics.load(view, 0), 126);
  });

  it('sets exit code 1 when blob import fails', async () => {
    const msg = createTestMessage({
      compileResult: {
        modules: {},
        jsFiles: { 'component.js': 'this is not valid JS for import' },
        cached: false,
      },
    });
    await handleRunMessage(msg);
    const view = new Int32Array(msg.exitSlotBuf);
    const code = Atomics.load(view, 0);
    assert.ok(code !== -1, 'exit code should be set');
    assert.ok(code !== 0, 'should not succeed with invalid JS');
  });

  it('closes all stdio streams on completion', async () => {
    const msg = createTestMessage();
    await handleRunMessage(msg);
    // Verify streams were disposed by checking WRITER_CLOSED/READER_CLOSED flags
    const stdoutControl = new Int32Array(msg.stdoutBuf, 0, 4);
    const stderrControl = new Int32Array(msg.stderrBuf, 0, 4);
    const stdinControl = new Int32Array(msg.stdinBuf, 0, 4);
    // stdout/stderr: WRITER_CLOSED should be set (output disposed)
    assert.equal(Atomics.load(stdoutControl, 2), 1, 'stdout writer should be closed');
    assert.equal(Atomics.load(stderrControl, 2), 1, 'stderr writer should be closed');
    // stdin: READER_CLOSED should be set (input disposed)
    assert.equal(Atomics.load(stdinControl, 3), 1, 'stdin reader should be closed');
  });
});

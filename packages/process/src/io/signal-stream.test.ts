import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wrapInputWithSignalCheck, wrapOutputWithSignalCheck } from './signal-stream.ts';
import { createSignalSlot } from './slots.ts';
import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler, type StreamError } from '@mithic/wasip2/io/streams';

describe('wrapInputWithSignalCheck', () => {
  it('read passes through when no signal pending', () => {
    const signalSlot = createSignalSlot();
    const inner = new InputStream({
      read() { return new Uint8Array([1, 2, 3]); },
      blockingRead() { return new Uint8Array([1, 2, 3]); },
    } as InputStreamHandler);
    const wrapped = wrapInputWithSignalCheck(inner, signalSlot);
    const data = wrapped.read(3n);
    assert.deepEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('read throws closed when signal is pending', () => {
    const signalSlot = createSignalSlot();
    signalSlot.send(2); // SIGINT
    const inner = new InputStream({
      read() { return new Uint8Array([1]); },
      blockingRead() { return new Uint8Array([1]); },
    } as InputStreamHandler);
    const wrapped = wrapInputWithSignalCheck(inner, signalSlot);
    assert.throws(
      () => wrapped.read(1n),
      (err: StreamError) => err.tag === 'closed',
    );
  });

  it('blockingRead throws closed when signal is pending before read', () => {
    const signalSlot = createSignalSlot();
    signalSlot.send(15); // SIGTERM
    const inner = new InputStream({
      read() { return new Uint8Array([1]); },
      blockingRead() { return new Uint8Array([1]); },
    } as InputStreamHandler);
    const wrapped = wrapInputWithSignalCheck(inner, signalSlot);
    assert.throws(
      () => wrapped.blockingRead(1n),
      (err: StreamError) => err.tag === 'closed',
    );
  });

  it('blockingRead checks signal after underlying read returns', () => {
    const signalSlot = createSignalSlot();
    let callCount = 0;
    const inner = new InputStream({
      read() { return new Uint8Array([1]); },
      blockingRead() {
        callCount++;
        signalSlot.send(2); // signal arrives during read
        return new Uint8Array([1]);
      },
    } as InputStreamHandler);
    const wrapped = wrapInputWithSignalCheck(inner, signalSlot);
    assert.throws(
      () => wrapped.blockingRead(1n),
      (err: StreamError) => err.tag === 'closed',
    );
    assert.equal(callCount, 1);
  });

  it('read returns undefined when inner returns undefined (no data)', () => {
    const signalSlot = createSignalSlot();
    const inner = new InputStream({
      read() { return undefined; },
      blockingRead() { return new Uint8Array(0); },
    } as InputStreamHandler);
    const wrapped = wrapInputWithSignalCheck(inner, signalSlot);
    const data = wrapped.read(10n);
    assert.equal(data.byteLength, 0);
  });
});

describe('wrapOutputWithSignalCheck', () => {
  it('write passes through when no signal pending', () => {
    const signalSlot = createSignalSlot();
    let written: Uint8Array | undefined;
    const inner = new OutputStream({
      checkWrite() { return 1000; },
      write(data: Uint8Array) { written = data; },
      flush() {},
    } as OutputStreamHandler);
    const wrapped = wrapOutputWithSignalCheck(inner, signalSlot);
    wrapped.write(new Uint8Array([1, 2]));
    assert.deepEqual(written, new Uint8Array([1, 2]));
  });

  it('write throws closed when signal is pending', () => {
    const signalSlot = createSignalSlot();
    signalSlot.send(2); // SIGINT
    const inner = new OutputStream({
      checkWrite() { return 1000; },
      write() {},
      flush() {},
    } as OutputStreamHandler);
    const wrapped = wrapOutputWithSignalCheck(inner, signalSlot);
    assert.throws(
      () => wrapped.write(new Uint8Array([1])),
      (err: StreamError) => err.tag === 'closed',
    );
  });

  it('checkWrite returns 0 when signal is pending', () => {
    const signalSlot = createSignalSlot();
    signalSlot.send(9); // SIGKILL
    const inner = new OutputStream({
      checkWrite() { return 1000; },
      write() {},
      flush() {},
    } as OutputStreamHandler);
    const wrapped = wrapOutputWithSignalCheck(inner, signalSlot);
    assert.equal(Number(wrapped.checkWrite()), 0);
  });

  it('flush passes through', () => {
    const signalSlot = createSignalSlot();
    let flushed = false;
    const inner = new OutputStream({
      checkWrite() { return 1000; },
      write() {},
      flush() { flushed = true; },
    } as OutputStreamHandler);
    const wrapped = wrapOutputWithSignalCheck(inner, signalSlot);
    wrapped.flush();
    assert.ok(flushed);
  });
});

describe('signal-aware stream integration', () => {
  it('SIGINT interrupts a blocking read sequence', () => {
    const signalSlot = createSignalSlot();
    let readAttempts = 0;
    const inner = new InputStream({
      read() { return undefined; },
      blockingRead() {
        readAttempts++;
        if (readAttempts === 2) signalSlot.send(2);
        if (readAttempts >= 2) throw { tag: 'closed' } as StreamError;
        return new Uint8Array([65]); // 'A'
      },
    } as InputStreamHandler);
    const wrapped = wrapInputWithSignalCheck(inner, signalSlot);

    // First read succeeds
    const first = wrapped.blockingRead(1n);
    assert.deepEqual(first, new Uint8Array([65]));

    // Second read gets interrupted by signal
    assert.throws(
      () => wrapped.blockingRead(1n),
      (err: StreamError) => err.tag === 'closed',
    );
  });
});

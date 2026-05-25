import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPipeHandlers as createPipe } from './utils.ts';
import { InputStream, OutputStream, type StreamError } from '@mithic/wasip2/io/streams';

describe('createPipe (QueuePipe)', () => {
  it('data written to output is readable from input', () => {
    const { input, output } = createPipe();
    const istream = new InputStream(input);
    const ostream = new OutputStream(output);

    ostream.write(new Uint8Array([1, 2, 3]));
    const data = istream.read(3n);
    assert.deepEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('read returns empty when no data available', () => {
    const { input } = createPipe();
    const istream = new InputStream(input);
    const data = istream.read(10n);
    assert.equal(data.byteLength, 0);
  });

  it('multiple writes are read in order', () => {
    const { input, output } = createPipe();
    const istream = new InputStream(input);
    const ostream = new OutputStream(output);

    ostream.write(new Uint8Array([1, 2]));
    ostream.write(new Uint8Array([3, 4]));

    const chunk1 = istream.read(2n);
    const chunk2 = istream.read(2n);
    assert.deepEqual(chunk1, new Uint8Array([1, 2]));
    assert.deepEqual(chunk2, new Uint8Array([3, 4]));
  });

  it('partial read returns requested length from chunk', () => {
    const { input, output } = createPipe();
    const istream = new InputStream(input);
    const ostream = new OutputStream(output);

    ostream.write(new Uint8Array([10, 20, 30, 40, 50]));
    const first = istream.read(2n);
    const rest = istream.read(10n);
    assert.deepEqual(first, new Uint8Array([10, 20]));
    assert.deepEqual(rest, new Uint8Array([30, 40, 50]));
  });

  describe('EOF propagation', () => {
    it('writer close causes blockingRead to throw closed', () => {
      const { input, output } = createPipe();
      output.drop!();
      assert.throws(
        () => input.blockingRead(10),
        (err: StreamError) => err.tag === 'closed',
      );
    });

    it('writer close causes read to throw closed when buffer empty', () => {
      const { input, output } = createPipe();
      output.drop!();
      assert.throws(
        () => input.read!(10),
        (err: StreamError) => err.tag === 'closed',
      );
    });

    it('subscribe becomes ready when writer closes', () => {
      const { input, output } = createPipe();
      const pollable = input.subscribe!();
      assert.equal(pollable.ready(), false);
      output.drop!();
      assert.equal(pollable.ready(), true);
    });
  });

  describe('broken-pipe', () => {
    it('reader close causes write to throw broken-pipe', () => {
      const { input, output } = createPipe();
      input.drop!();
      assert.throws(
        () => output.write(new Uint8Array([1])),
        (err: StreamError) => err.tag === 'last-operation-failed',
      );
    });

    it('checkWrite returns 0 when reader is closed', () => {
      const { input, output } = createPipe();
      input.drop!();
      assert.equal(output.checkWrite!(), 0);
    });
  });

  describe('backpressure', () => {
    it('checkWrite returns available space', () => {
      const { input: _, output } = createPipe({ bufferSize: 100 });
      assert.equal(output.checkWrite!(), 100);
    });

    it('checkWrite decreases as data is written', () => {
      const { input: _, output } = createPipe({ bufferSize: 100 });
      output.write(new Uint8Array(60));
      assert.equal(output.checkWrite!(), 40);
    });

    it('checkWrite returns 0 when buffer is full', () => {
      const { input: _, output } = createPipe({ bufferSize: 10 });
      output.write(new Uint8Array(10));
      assert.equal(output.checkWrite!(), 0);
    });

    it('reading frees space', () => {
      const { input, output } = createPipe({ bufferSize: 10 });
      const istream = new InputStream(input);
      output.write(new Uint8Array(10));
      assert.equal(output.checkWrite!(), 0);
      istream.read(5n);
      assert.equal(output.checkWrite!(), 5);
    });

    it('subscribe on output becomes ready when space available', () => {
      const { input, output } = createPipe({ bufferSize: 5 });
      const istream = new InputStream(input);
      output.write(new Uint8Array(5));
      const pollable = output.subscribe!();
      assert.equal(pollable.ready(), false);
      istream.read(1n);
      assert.equal(pollable.ready(), true);
    });
  });
});

describe('createPipe (SharedPipe)', () => {
  it('data written to output is readable from input', () => {
    const { input, output } = createPipe({ shared: true, bufferSize: 1024 });
    const istream = new InputStream(input);
    const ostream = new OutputStream(output);

    ostream.write(new Uint8Array([5, 6, 7]));
    const data = istream.read(3n);
    assert.deepEqual(data, new Uint8Array([5, 6, 7]));
  });

  it('writer close causes blockingRead to throw closed', () => {
    const { input, output } = createPipe({ shared: true });
    output.drop!();
    assert.throws(
      () => input.blockingRead(10),
      (err: StreamError) => err.tag === 'closed',
    );
  });

  it('reader close causes write to throw broken-pipe', () => {
    const { input, output } = createPipe({ shared: true });
    input.drop!();
    assert.throws(
      () => output.write(new Uint8Array([1])),
      (err: StreamError) => err.tag === 'last-operation-failed',
    );
  });

  it('subscribe becomes ready when data available', () => {
    const { input, output } = createPipe({ shared: true, bufferSize: 1024 });
    const pollable = input.subscribe!();
    assert.equal(pollable.ready(), false);
    output.write(new Uint8Array([1]));
    assert.equal(pollable.ready(), true);
  });
});

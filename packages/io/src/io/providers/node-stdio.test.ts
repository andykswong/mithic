import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeAsyncStdinHandler } from './node-stdio.ts';

describe('NodeAsyncStdinHandler', () => {
  it('read returns undefined when buffer is empty', () => {
    const handler = new NodeAsyncStdinHandler();
    assert.strictEqual(handler.read(10), undefined);
  });

  it('blockingRead resolves when data arrives via stdin', async () => {
    const handler = new NodeAsyncStdinHandler();
    const promise = handler.blockingRead(5);
    // Simulate data arrival by emitting on process.stdin
    process.stdin.emit('data', Buffer.from('hello'));
    const result = await promise;
    assert.deepStrictEqual(result, new Uint8Array([104, 101, 108, 108, 111]));
  });

  it('read returns buffered data after stdin emits', () => {
    const handler = new NodeAsyncStdinHandler();
    process.stdin.emit('data', Buffer.from('world'));
    const result = handler.read(5);
    assert.deepStrictEqual(result, new Uint8Array([119, 111, 114, 108, 100]));
  });

  it('read returns partial data when len < buffer', () => {
    const handler = new NodeAsyncStdinHandler();
    process.stdin.emit('data', Buffer.from('abcdef'));
    const result = handler.read(3);
    assert.deepStrictEqual(result, new Uint8Array([97, 98, 99]));
    // Remaining 'def' still in buffer
    const rest = handler.read(3);
    assert.deepStrictEqual(rest, new Uint8Array([100, 101, 102]));
  });

  it('blockingRead rejects with closed tag on end', async () => {
    const handler = new NodeAsyncStdinHandler();
    process.stdin.emit('end');
    await assert.rejects(handler.blockingRead(5), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });

  it('read throws closed tag after end', () => {
    const handler = new NodeAsyncStdinHandler();
    process.stdin.emit('end');
    assert.throws(() => handler.read(5), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });
});

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { NodeAsyncStdinHandler } from './node-stdio.ts';

describe('NodeAsyncStdinHandler', () => {
  let handler: NodeAsyncStdinHandler;

  afterEach(() => {
    handler?.drop?.();
  });

  it('read returns undefined when buffer is empty', () => {
    handler = new NodeAsyncStdinHandler();
    assert.strictEqual(handler.read(10), undefined);
  });

  it('blockingRead resolves when data arrives via stdin', async () => {
    handler = new NodeAsyncStdinHandler();
    const promise = handler.blockingRead(5);
    process.stdin.emit('data', Buffer.from('hello'));
    const result = await promise;
    assert.deepStrictEqual(result, new Uint8Array([104, 101, 108, 108, 111]));
  });

  it('read returns buffered data after stdin emits', () => {
    handler = new NodeAsyncStdinHandler();
    process.stdin.emit('data', Buffer.from('world'));
    const result = handler.read(5);
    assert.deepStrictEqual(result, new Uint8Array([119, 111, 114, 108, 100]));
  });

  it('read returns partial data when len < buffer', () => {
    handler = new NodeAsyncStdinHandler();
    process.stdin.emit('data', Buffer.from('abcdef'));
    const result = handler.read(3);
    assert.deepStrictEqual(result, new Uint8Array([97, 98, 99]));
    const rest = handler.read(3);
    assert.deepStrictEqual(rest, new Uint8Array([100, 101, 102]));
  });

  it('blockingRead rejects with closed tag on end', async () => {
    handler = new NodeAsyncStdinHandler();
    process.stdin.emit('end');
    await assert.rejects(handler.blockingRead(5), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });

  it('read throws closed tag after end', () => {
    handler = new NodeAsyncStdinHandler();
    process.stdin.emit('end');
    assert.throws(() => handler.read(5), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });

  it('drop removes listeners and pauses stdin', () => {
    handler = new NodeAsyncStdinHandler();
    const listenersBefore = process.stdin.listenerCount('data');
    handler.drop();
    assert.strictEqual(process.stdin.listenerCount('data'), listenersBefore - 1);
  });
});

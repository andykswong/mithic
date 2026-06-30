import { expect, test } from 'vitest';
import { PipeReader } from '@mithic/protocol';
import { pumpToPort } from './pump.ts';

/**
 * Drain a pipe READ port honoring the credit protocol (a small window so a
 * source chunk LARGER than the window must be sub-chunked by `pumpToPort`),
 * collecting the bytes in arrival order. Resolves on `{type:'end'}`.
 */
function collectViaWindow(readPort: MessagePort, windowBytes: number): Promise<Uint8Array[]> {
  return new Promise<Uint8Array[]>((resolve) => {
    const chunks: Uint8Array[] = [];
    const flow = new PipeReader(windowBytes);
    readPort.start?.();
    readPort.postMessage({ type: 'credit', bytes: flow.open() });
    readPort.onmessage = (e: MessageEvent): void => {
      const msg = e.data as { type?: string; chunk?: Uint8Array };
      if (msg?.type === 'data' && msg.chunk) {
        chunks.push(new Uint8Array(msg.chunk));
        flow.recordArrival(msg.chunk.byteLength);
        const grant = flow.replenish();
        if (grant > 0) readPort.postMessage({ type: 'credit', bytes: grant });
      } else if (msg?.type === 'end') {
        resolve(chunks);
      }
    };
  });
}

/** A source that yields the given chunks once each, then EOF (null). */
function chunkSource(chunks: Uint8Array[]): () => Promise<Uint8Array | null> {
  let i = 0;
  return async () => (i < chunks.length ? chunks[i++] : null);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

test('pumpToPort delivers all bytes in order across a small credit window, then EOF', async () => {
  const { port1, port2 } = new MessageChannel();
  const window = 8;
  // A multi-chunk source including a chunk LARGER than the window (must sub-chunk).
  const source = [
    new Uint8Array([1, 2, 3]),
    new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), // 11 bytes > 8 window
    new Uint8Array([99]),
  ];
  const expected = concat(source);

  const collected = collectViaWindow(port1, window);
  const broken = await pumpToPort(port2, chunkSource(source), window);

  expect(broken).toBe(false);
  const got = concat(await collected);
  expect(got).toEqual(expected);
  // Sub-chunking: no delivered chunk exceeds the window.
  const chunks = await collected;
  for (const c of chunks) expect(c.byteLength).toBeLessThanOrEqual(window);
});

test('pumpToPort skips zero-length chunks and still terminates on EOF', async () => {
  const { port1, port2 } = new MessageChannel();
  const source = [new Uint8Array([1]), new Uint8Array(0), new Uint8Array([2, 3])];
  const collected = collectViaWindow(port1, 64);
  const broken = await pumpToPort(port2, chunkSource(source), 64);
  expect(broken).toBe(false);
  expect(concat(await collected)).toEqual(new Uint8Array([1, 2, 3]));
});

test('pumpToPort stops and reports broken when the peer sends {type:error}', async () => {
  const { port1, port2 } = new MessageChannel();
  // Reader grants NO credit and immediately breaks the pipe — the first reserve()
  // parks then rejects, so the pump must stop promptly (not hang) and report broken.
  let nextCalls = 0;
  const source = (): Promise<Uint8Array | null> => {
    nextCalls++;
    return Promise.resolve(new Uint8Array([1, 2, 3, 4]));
  };
  port1.start?.();
  port1.postMessage({ type: 'error' });

  const broken = await pumpToPort(port2, source, 64);
  expect(broken).toBe(true);
  // The pump fetched at most the first chunk then bailed on the broken reserve;
  // it did not loop forever pulling from the (infinite) source.
  expect(nextCalls).toBeLessThanOrEqual(1);
});

test('pumpToPort reports broken when the peer sends {type:end} before any credit', async () => {
  const { port1, port2 } = new MessageChannel();
  port1.start?.();
  port1.postMessage({ type: 'end' });
  // An infinite source: if markBroken did not stop the pump, this would hang.
  const source = (): Promise<Uint8Array | null> => Promise.resolve(new Uint8Array([0]));
  const broken = await pumpToPort(port2, source, 64);
  expect(broken).toBe(true);
});

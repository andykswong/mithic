import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler, type StreamError } from '@mithic/wasip2/io/streams';
import type { MaybePromise } from '@mithic/io';
import type { SignalSlot } from './slots.ts';

export function wrapInputWithSignalCheck<Sync extends boolean>(stream: InputStream<Sync>, signalSlot: SignalSlot): InputStream<Sync> {
  const handler: InputStreamHandler<Sync> = {
    read(len: number): Uint8Array | undefined {
      if (signalSlot.pending() !== 0) throw { tag: 'closed' } as StreamError;
      return stream.read(BigInt(len)) as unknown as Uint8Array | undefined;
    },
    blockingRead(len: number): MaybePromise<Uint8Array, Sync> {
      if (signalSlot.pending() !== 0) throw { tag: 'closed' } as StreamError;
      const result = stream.blockingRead(BigInt(len));
      if (result instanceof Promise) {
        return result.then(data => {
          if (signalSlot.pending() !== 0) throw { tag: 'closed' } as StreamError;
          return data;
        }) as MaybePromise<Uint8Array, Sync>;
      }
      if (signalSlot.pending() !== 0) throw { tag: 'closed' } as StreamError;
      return result;
    },
    drop() { stream[Symbol.dispose]?.(); },
  };
  return new InputStream(handler, () => stream.subscribe(), stream.isatty);
}

export function wrapOutputWithSignalCheck<Sync extends boolean>(stream: OutputStream<Sync>, signalSlot: SignalSlot): OutputStream<Sync> {
  const handler: OutputStreamHandler<Sync> = {
    checkWrite(): number {
      if (signalSlot.pending() !== 0) return 0;
      return Number(stream.checkWrite());
    },
    write(data: Uint8Array): void {
      if (signalSlot.pending() !== 0) {
        throw { tag: 'closed' } as StreamError;
      }
      stream.write(data);
    },
    flush(): MaybePromise<void, Sync> {
      return stream.flush();
    },
    drop() { stream[Symbol.dispose]?.(); },
  };
  return new OutputStream(handler, () => stream.subscribe(), stream.isatty);
}

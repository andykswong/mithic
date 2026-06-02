import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler, type StreamError } from '@mithic/wasip2/io/streams';
import type { SignalSlot } from './slots.ts';

export function wrapInputWithSignalCheck(stream: InputStream, signalSlot: SignalSlot): InputStream {
  const handler: InputStreamHandler = {
    read(len: number): Uint8Array | undefined {
      if (signalSlot.pending() !== 0) throw { tag: 'closed' } as StreamError;
      return stream.read(BigInt(len)) as unknown as Uint8Array | undefined;
    },
    blockingRead(len: number): Uint8Array {
      if (signalSlot.pending() !== 0) throw { tag: 'closed' } as StreamError;
      const result = stream.blockingRead(BigInt(len));
      if (signalSlot.pending() !== 0) throw { tag: 'closed' } as StreamError;
      return result;
    },
    drop() { stream[Symbol.dispose]?.(); },
  };
  return new InputStream(handler, () => stream.subscribe(), stream.isatty);
}

export function wrapOutputWithSignalCheck(stream: OutputStream, signalSlot: SignalSlot): OutputStream {
  const handler: OutputStreamHandler = {
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
    flush(): void { stream.flush(); },
    drop() { stream[Symbol.dispose]?.(); },
  };
  return new OutputStream(handler, () => stream.subscribe(), stream.isatty);
}

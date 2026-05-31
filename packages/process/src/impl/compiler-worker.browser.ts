import { handleBlockingCalls } from '@mithic/io/io';
import { compilerHandler } from './compiler-handler.ts';

declare const self: { onmessage: ((e: MessageEvent) => void) | null };

self.onmessage = (e: MessageEvent) => {
  if (e.data?.type === '__port') {
    handleBlockingCalls(compilerHandler, e.data.port);
  }
};

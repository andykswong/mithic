import { handleBlockingCalls } from '@mithic/io/io';
import { compilerHandler } from './compiler.ts';

self.onmessage = (e: MessageEvent) => {
  if (e.data?.type === '__port') {
    handleBlockingCalls(compilerHandler, e.data.port);
  }
};

import { parentPort } from 'node:worker_threads';
import { handleBlockingCalls } from '@mithic/io/io';
import { compilerHandler } from './compiler-handler.ts';

parentPort?.on('message', (msg) => {
  if (msg?.type === '__port') {
    handleBlockingCalls(compilerHandler, msg.port);
  }
});
